/**
 * Sensitive Place Detection Evaluation
 *
 * Measures how well the on-device place detection algorithm
 * recovers ground-truth home/work locations from location history.
 *
 * Ground truth: extracted in preprocess.mjs via nighttime/daytime clustering
 * Detection: detectSensitivePlaces() from privacy-location.ts
 *
 * Metrics:
 * - Home detection rate (what fraction of users have home detected?)
 * - Home centroid error (distance from detected home to ground truth)
 * - Work detection rate
 * - False positive rate (detected places that don't match home or work)
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
  console.log(`Evaluating place detection for ${usersMeta.length} users`);

  const results = [];

  // Try multiple training window sizes
  const windows = [14, 30, 60, 90];

  for (const windowDays of windows) {
    let homeDetected = 0, homeCorrect = 0;
    let workDetected = 0, workCorrect = 0;
    let falsePositives = 0;
    const homeErrors = [];
    const workErrors = [];
    let totalUsers = 0;

    for (const user of usersMeta) {
      const locs = JSON.parse(await readFile(join(PROCESSED_DIR, `${user.userId}.json`), 'utf-8'));
      const training = locs.filter(l => l.day < windowDays).map(l => ({
        lat: l.lat, lon: l.lon, timestamp: l.timestamp,
      }));

      if (training.length < 10) continue;
      totalUsers++;

      // Run detection with relaxed params (matching GeoLife's sparsity)
      const detected = detectSensitivePlaces(training, {
        ...DEFAULT_PRIVACY_CONFIG,
        minVisitsForSensitive: 3,
        minDwellMinutes: 30,
      });

      // Match detected places to ground truth
      const homeGt = user.home;
      const workGt = user.work;

      let homeMatched = false;
      let workMatched = false;

      for (const place of detected) {
        const distToHome = haversine(place.lat, place.lon, homeGt.lat, homeGt.lon);
        const distToWork = workGt ? haversine(place.lat, place.lon, workGt.lat, workGt.lon) : Infinity;

        if (distToHome < 1000) {
          homeDetected++;
          homeMatched = true;
          homeErrors.push(Math.round(distToHome));
          if (place.label === 'home') homeCorrect++;
        } else if (distToWork < 1000) {
          workDetected++;
          workMatched = true;
          workErrors.push(Math.round(distToWork));
          if (place.label === 'work') workCorrect++;
        } else {
          falsePositives++;
        }
      }
    }

    homeErrors.sort((a, b) => a - b);
    workErrors.sort((a, b) => a - b);
    const med = (arr) => arr.length > 0 ? arr[Math.floor(arr.length * 0.5)] : null;

    const r = {
      windowDays,
      totalUsers,
      homeDetectionRate: Math.round(homeDetected / totalUsers * 100) / 100,
      homeCorrectLabel: homeCorrect,
      homeMedianError: med(homeErrors),
      workDetectionRate: Math.round(workDetected / totalUsers * 100) / 100,
      workCorrectLabel: workCorrect,
      workMedianError: med(workErrors),
      falsePositives,
      falsePositiveRate: Math.round(falsePositives / totalUsers * 100) / 100,
    };
    results.push(r);

    console.log(`\nWindow: ${windowDays} days (${totalUsers} users)`);
    console.log(`  Home: detected ${homeDetected}/${totalUsers} (${r.homeDetectionRate}), median error ${r.homeMedianError}m, correct label ${homeCorrect}`);
    console.log(`  Work: detected ${workDetected}/${totalUsers} (${r.workDetectionRate}), median error ${r.workMedianError}m, correct label ${workCorrect}`);
    console.log(`  False positives: ${falsePositives} (${r.falsePositiveRate} per user)`);
  }

  await writeFile(join(RESULTS_DIR, 'place-detection.json'), JSON.stringify(results, null, 2));
  console.log('\nResults saved.');
}

main().catch(console.error);
