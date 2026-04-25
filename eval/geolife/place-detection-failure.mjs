/**
 * Place detection failure analysis
 *
 * For each of the 78 GeoLife users, runs the on-device sensitive
 * place detection and classifies success/failure by coverage profile:
 *   - Overall coverage
 *   - Night coverage (22:00-06:00)
 *   - Weekday-daytime coverage (Mon-Fri 09:00-17:00)
 *
 * Output: per-quantile detection rates, showing which coverage
 * profile drives detection success.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

import {
  detectSensitivePlaces,
  DEFAULT_PRIVACY_CONFIG,
} from '../../packages/sdk/dist/privacy-location.js';

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

  const perUser = [];
  for (const user of usersMeta) {
    const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));

    // Compute coverage profile
    const totalHours = 90 * 24;
    const overall = locs.length / totalHours;

    let nightCnt = 0, weekdayDayCnt = 0;
    const nightTotal = 90 * 8; // 22:00-06:00 = 8 hours/day
    const weekdayDayTotal = 90 * (5 / 7) * 8; // Mon-Fri 09:00-17:00
    for (const l of locs) {
      const isNight = l.hour >= 22 || l.hour < 6;
      const isWeekday = !l.isWeekend;
      const isDayHour = l.hour >= 9 && l.hour < 17;
      if (isNight) nightCnt++;
      if (isWeekday && isDayHour) weekdayDayCnt++;
    }
    const nightCov = nightCnt / nightTotal;
    const weekdayDayCov = weekdayDayCnt / weekdayDayTotal;

    // Run on-device detection (matching place-detection-eval.mjs config)
    const history = locs.map(l => ({ lat: l.lat, lon: l.lon, timestamp: l.timestamp }));
    const detected = detectSensitivePlaces(history, {
      ...DEFAULT_PRIVACY_CONFIG,
      minVisitsForSensitive: 3,
      minDwellMinutes: 30,
    });

    // Classify each detection (loose criterion: any cluster within 1km
    // of ground truth, matching place-detection-eval.mjs)
    let homeDetected = false, workDetected = false, homeErr = null, workErr = null;
    for (const d of detected) {
      const distToHome = haversine(d.lat, d.lon, user.home.lat, user.home.lon);
      if (distToHome < 1000) {
        homeDetected = true;
        homeErr = Math.round(distToHome);
      } else if (user.work) {
        const distToWork = haversine(d.lat, d.lon, user.work.lat, user.work.lon);
        if (distToWork < 1000) {
          workDetected = true;
          workErr = Math.round(distToWork);
        }
      }
    }

    perUser.push({
      userId: user.userId,
      coverage: overall,
      nightCoverage: nightCov,
      weekdayDayCoverage: weekdayDayCov,
      hasWork: !!user.work,
      detectedCount: detected.length,
      homeDetected,
      workDetected,
      homeErr,
      workErr,
    });
  }

  // Sort by overall coverage and bin into quartiles
  perUser.sort((a, b) => a.coverage - b.coverage);
  const n = perUser.length;
  const q = (frac) => perUser[Math.min(n - 1, Math.floor(n * frac))];

  const buckets = [
    { label: 'Q1 (lowest)', start: 0, end: Math.floor(n * 0.25) },
    { label: 'Q2', start: Math.floor(n * 0.25), end: Math.floor(n * 0.5) },
    { label: 'Q3', start: Math.floor(n * 0.5), end: Math.floor(n * 0.75) },
    { label: 'Q4 (highest)', start: Math.floor(n * 0.75), end: n },
  ];

  console.log('=== Detection rate by overall coverage quartile ===');
  console.log('Quartile        n   Cov range          HomeDet    WorkDet   HomeErr(med)');
  const byOverall = [];
  for (const b of buckets) {
    const slice = perUser.slice(b.start, b.end);
    const homeRate = slice.filter(u => u.homeDetected).length / slice.length;
    const withWork = slice.filter(u => u.hasWork);
    const workRate = withWork.length > 0 ? withWork.filter(u => u.workDetected).length / withWork.length : 0;
    const homeErrs = slice.filter(u => u.homeErr !== null).map(u => u.homeErr).sort((a, b) => a - b);
    const medHomeErr = homeErrs.length > 0 ? Math.round(homeErrs[Math.floor(homeErrs.length / 2)]) : null;
    const cmin = (slice[0].coverage * 100).toFixed(0);
    const cmax = (slice[slice.length - 1].coverage * 100).toFixed(0);
    byOverall.push({ label: b.label, n: slice.length, covMin: +cmin, covMax: +cmax, homeRate, workRate, medHomeErr });
    console.log(`  ${b.label.padEnd(14)} ${slice.length.toString().padStart(3)}   ${(cmin + '%').padStart(4)}--${(cmax + '%').padStart(4)}      ${(homeRate * 100).toFixed(0).padStart(3)}%       ${(workRate * 100).toFixed(0).padStart(3)}%      ${medHomeErr !== null ? medHomeErr + 'm' : '--'}`);
  }

  // Same for night coverage
  perUser.sort((a, b) => a.nightCoverage - b.nightCoverage);
  console.log('\n=== Detection rate by night-coverage quartile ===');
  console.log('Quartile        n   Night cov          HomeDet    WorkDet');
  const byNight = [];
  for (const b of buckets) {
    const slice = perUser.slice(b.start, b.end);
    const homeRate = slice.filter(u => u.homeDetected).length / slice.length;
    const withWork = slice.filter(u => u.hasWork);
    const workRate = withWork.length > 0 ? withWork.filter(u => u.workDetected).length / withWork.length : 0;
    const cmin = (slice[0].nightCoverage * 100).toFixed(0);
    const cmax = (slice[slice.length - 1].nightCoverage * 100).toFixed(0);
    byNight.push({ label: b.label, n: slice.length, covMin: +cmin, covMax: +cmax, homeRate, workRate });
    console.log(`  ${b.label.padEnd(14)} ${slice.length.toString().padStart(3)}   ${(cmin + '%').padStart(4)}--${(cmax + '%').padStart(4)}      ${(homeRate * 100).toFixed(0).padStart(3)}%       ${(workRate * 100).toFixed(0).padStart(3)}%`);
  }

  // Same for weekday-day coverage
  perUser.sort((a, b) => a.weekdayDayCoverage - b.weekdayDayCoverage);
  console.log('\n=== Detection rate by weekday-day-coverage quartile ===');
  console.log('Quartile        n   Wday-day cov       HomeDet    WorkDet');
  const byWeekday = [];
  for (const b of buckets) {
    const slice = perUser.slice(b.start, b.end);
    const homeRate = slice.filter(u => u.homeDetected).length / slice.length;
    const withWork = slice.filter(u => u.hasWork);
    const workRate = withWork.length > 0 ? withWork.filter(u => u.workDetected).length / withWork.length : 0;
    const cmin = (slice[0].weekdayDayCoverage * 100).toFixed(0);
    const cmax = (slice[slice.length - 1].weekdayDayCoverage * 100).toFixed(0);
    byWeekday.push({ label: b.label, n: slice.length, covMin: +cmin, covMax: +cmax, homeRate, workRate });
    console.log(`  ${b.label.padEnd(14)} ${slice.length.toString().padStart(3)}   ${(cmin + '%').padStart(4)}--${(cmax + '%').padStart(4)}      ${(homeRate * 100).toFixed(0).padStart(3)}%       ${(workRate * 100).toFixed(0).padStart(3)}%`);
  }

  // Aggregate
  const homeDetRate = perUser.filter(u => u.homeDetected).length / perUser.length;
  const workDetRate = perUser.filter(u => u.hasWork && u.workDetected).length / perUser.filter(u => u.hasWork).length;
  console.log(`\nOverall: home det = ${(homeDetRate * 100).toFixed(0)}%, work det (of users with work) = ${(workDetRate * 100).toFixed(0)}%`);

  await writeFile(join(RESULTS_DIR, 'place-detection-failure.json'), JSON.stringify({
    perUser,
    byOverall,
    byNight,
    byWeekday,
    overall: { homeDetRate, workDetRate },
  }, null, 2));
  console.log('\nSaved to results/place-detection-failure.json');
}

main().catch(e => { console.error(e); process.exit(1); });
