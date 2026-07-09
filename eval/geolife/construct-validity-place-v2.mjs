/**
 * Paper ① — K1 v2: panel-review fixes (2026-06-10).
 *  - FIXED COHORT: the window trend is computed only over users evaluable at
 *    EVERY window (and, for work, with a derived work GT), so the trend is not
 *    confounded with cohort composition (panel issue M1).
 *  - INTEGER numerators/denominators for every cell.
 *  - Wilson 95% CIs on every proportion.
 * Keeps v1 (full per-window cohort) as a secondary table for comparison.
 * Caveat unchanged: GT is DERIVED (night/day clustering) → this measures the
 * RELIABILITY/stability of the labeling rule, not validity vs a human criterion.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { detectSensitivePlaces, DEFAULT_PRIVACY_CONFIG } from '../../packages/sdk/dist/privacy-location.js';

const PD = join(import.meta.dirname, 'processed');
const RD = join(import.meta.dirname, 'results');
const R = 1000;
const WINDOWS = [7, 14, 30, 60, 90];

function hav(a, b, c, d) {
  const E = 6371000, p = Math.PI / 180;
  const x = Math.min(1, Math.sin((c-a)*p/2)**2 + Math.cos(a*p)*Math.cos(c*p)*Math.sin((d-b)*p/2)**2);
  return E * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

// Wilson 95% CI for a proportion
function wilson(k, n) {
  if (!n) return null;
  const z = 1.96, p = k / n, z2 = z * z;
  const den = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / den;
  const h = (z / den) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return { pct: +(100 * p).toFixed(1), lo: +(100 * Math.max(0, c - h)).toFixed(1), hi: +(100 * Math.min(1, c + h)).toFixed(1), k, n };
}

async function main() {
  await mkdir(RD, { recursive: true });
  const users = JSON.parse(await readFile(join(PD, 'users.json'), 'utf-8'));

  // pass 1: per-user, per-window detection outcomes
  const perUser = [];
  for (const u of users) {
    const locs = JSON.parse(await readFile(join(PD, `${u.userId}.json`), 'utf-8'));
    const row = { userId: u.userId, hasWorkGT: !!u.work, win: {} };
    for (const w of WINDOWS) {
      const tr = locs.filter(l => l.day < w).map(l => ({ lat: l.lat, lon: l.lon, timestamp: l.timestamp }));
      if (tr.length < 10) { row.win[w] = null; continue; }
      const det = detectSensitivePlaces(tr, { ...DEFAULT_PRIVACY_CONFIG, minVisitsForSensitive: 3, minDwellMinutes: 30 });
      const hp = det.filter(p => hav(p.lat, p.lon, u.home.lat, u.home.lon) <= R);
      const o = {
        nPlaces: det.length,
        homeRegion: hp.length > 0, homeRight: hp.some(p => p.label === 'home'),
        workRegion: false, workRight: false,
      };
      if (u.work) {
        const wp = det.filter(p => hav(p.lat, p.lon, u.work.lat, u.work.lon) <= R);
        o.workRegion = wp.length > 0; o.workRight = wp.some(p => p.label === 'work');
      }
      row.win[w] = o;
    }
    perUser.push(row);
  }

  // cohorts
  const allWin = perUser.filter(r => WINDOWS.every(w => r.win[w]));          // evaluable at every window
  const workCohort = allWin.filter(r => r.hasWorkGT);                        // + derived work GT exists

  function tabulate(rows, w) {
    const n = rows.length;
    const hr = rows.filter(r => r.win[w].homeRegion).length;
    const hc = rows.filter(r => r.win[w].homeRight).length;
    const wr = rows.filter(r => r.hasWorkGT && r.win[w].workRegion).length;
    const wc = rows.filter(r => r.hasWorkGT && r.win[w].workRight).length;
    const nWork = rows.filter(r => r.hasWorkGT).length;
    const places = rows.reduce((s, r) => s + r.win[w].nPlaces, 0);
    return {
      windowDays: w, users: n, usersWithWorkGT: nWork,
      avgPlacesPerUser: +(places / n).toFixed(2),
      homeRegionDetected: wilson(hr, n),
      homeCorrectlyLabeled: wilson(hc, n),
      homeLabelPrecision: wilson(hc, hr),
      workRegionDetected: wilson(wr, nWork),
      workCorrectlyLabeled: wilson(wc, nWork),
      workLabelPrecision: wilson(wc, wr),
    };
  }

  const fixedCohort = WINDOWS.map(w => tabulate(allWin, w));
  const fullCohort = WINDOWS.map(w => tabulate(perUser.filter(r => r.win[w]), w));

  const out = {
    _construct: 'K1 meaningful-place (v2: fixed cohort + integer counts + Wilson 95% CIs)',
    _caveat: 'GT home/work is DERIVED (night/day clustering) → RELIABILITY/stability of the labeling rule, not validity vs human criterion. Region match R=1000m. Fixed cohort = users evaluable (≥10 fixes) at every window.',
    fixedCohortUsers: allWin.length, fixedCohortWithWorkGT: workCohort.length,
    fixedCohort, fullCohort,
  };
  await writeFile(join(RD, 'construct-validity-place-v2.json'), JSON.stringify(out, null, 2));

  const fmt = c => c ? `${c.k}/${c.n}=${c.pct}% [${c.lo},${c.hi}]` : '—';
  console.log(`FIXED COHORT: ${allWin.length} users (${workCohort.length} with work GT)`);
  for (const r of fixedCohort) {
    console.log(`w=${String(r.windowDays).padStart(2)}  homeDet ${fmt(r.homeRegionDetected)}  homeLab ${fmt(r.homeCorrectlyLabeled)}  homePrec ${fmt(r.homeLabelPrecision)}`);
    console.log(`      workDet ${fmt(r.workRegionDetected)}  workLab ${fmt(r.workCorrectlyLabeled)}  workPrec ${fmt(r.workLabelPrecision)}  places/u=${r.avgPlacesPerUser}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
