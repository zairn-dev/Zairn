/**
 * Paper ① — K1 (meaningful place) construct-validity / stability analysis.
 *
 * Defensible reframing of place-detection-eval.mjs: separate DETECTION
 * (a cluster is found near the place) from CORRECT LABELING (the place's
 * role is resolved). HONESTY CAVEAT (state in paper): GeoLife has no human
 * home/work labels — "ground truth" is itself derived (night/day clustering)
 * — so this measures construct STABILITY / self-agreement, not validity
 * against a human criterion. The non-obvious result: with more observation,
 * the system finds the place but does NOT get better at naming its role.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { detectSensitivePlaces, DEFAULT_PRIVACY_CONFIG } from '../../packages/sdk/dist/privacy-location.js';

const PD = join(import.meta.dirname, 'processed');
const RD = join(import.meta.dirname, 'results');
const R = 1000; // region-match radius (m)

function hav(a, b, c, d) {
  const E = 6371000, p = Math.PI / 180;
  const x = Math.min(1, Math.sin((c-a)*p/2)**2 + Math.cos(a*p)*Math.cos(c*p)*Math.sin((d-b)*p/2)**2);
  return E * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

async function main() {
  await mkdir(RD, { recursive: true });
  const users = JSON.parse(await readFile(join(PD, 'users.json'), 'utf-8'));
  const windows = [7, 14, 30, 60, 90];
  const out = [];

  for (const w of windows) {
    let n = 0, homeRegion = 0, homeRight = 0, workRegion = 0, workRight = 0, placesTot = 0, usersWithWork = 0;
    for (const u of users) {
      const locs = JSON.parse(await readFile(join(PD, `${u.userId}.json`), 'utf-8'));
      const tr = locs.filter(l => l.day < w).map(l => ({ lat: l.lat, lon: l.lon, timestamp: l.timestamp }));
      if (tr.length < 10) continue;
      n++;
      const det = detectSensitivePlaces(tr, { ...DEFAULT_PRIVACY_CONFIG, minVisitsForSensitive: 3, minDwellMinutes: 30 });
      placesTot += det.length;
      const hp = det.filter(p => hav(p.lat, p.lon, u.home.lat, u.home.lon) <= R);
      if (hp.length) { homeRegion++; if (hp.some(p => p.label === 'home')) homeRight++; }
      if (u.work) {
        usersWithWork++;
        const wp = det.filter(p => hav(p.lat, p.lon, u.work.lat, u.work.lon) <= R);
        if (wp.length) { workRegion++; if (wp.some(p => p.label === 'work')) workRight++; }
      }
    }
    out.push({
      windowDays: w, users: n, avgPlacesPerUser: +(placesTot / n).toFixed(2),
      homeRegionDetectedPct: +(100 * homeRegion / n).toFixed(1),
      homeCorrectlyLabeledPct: +(100 * homeRight / n).toFixed(1),
      homeLabelPrecisionPct: homeRegion ? +(100 * homeRight / homeRegion).toFixed(1) : null,
      workRegionDetectedPct: +(100 * workRegion / usersWithWork).toFixed(1),
      workCorrectlyLabeledPct: +(100 * workRight / usersWithWork).toFixed(1),
      workLabelPrecisionPct: workRegion ? +(100 * workRight / workRegion).toFixed(1) : null,
    });
  }

  await writeFile(join(RD, 'construct-validity-place.json'), JSON.stringify({
    _construct: 'K1 meaningful-place',
    _caveat: 'GT home/work is DERIVED (night/day clustering), not human-labeled → STABILITY/self-agreement, not validity vs human criterion (the honesty gap). Region match R=1000m.',
    results: out,
  }, null, 2));

  console.log('win users places/u | home: region%  labeled%  labelPrec% | work: region%  labeled%  labelPrec%');
  for (const r of out) console.log(
    String(r.windowDays).padStart(3), String(r.users).padStart(5), String(r.avgPlacesPerUser).padStart(8),
    '|', String(r.homeRegionDetectedPct).padStart(9), String(r.homeCorrectlyLabeledPct).padStart(9), String(r.homeLabelPrecisionPct).padStart(10),
    '|', String(r.workRegionDetectedPct).padStart(9), String(r.workCorrectlyLabeledPct).padStart(9), String(r.workLabelPrecisionPct).padStart(10),
  );
}
main().catch(e => { console.error(e); process.exit(1); });
