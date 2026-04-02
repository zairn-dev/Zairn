/**
 * GeoLife Dataset Preprocessor
 *
 * Parses raw GeoLife .plt trajectory files into a unified format
 * suitable for privacy attack simulation.
 *
 * Input:  eval/geolife/Geolife Trajectories 1.3/Data/{userId}/Trajectory/*.plt
 * Output: eval/geolife/processed/users.json       — user metadata + home location
 *         eval/geolife/processed/{userId}.json     — hourly location traces
 *
 * Each user's trace is resampled to hourly observations over 90 days
 * (the longest contiguous window with sufficient data).
 */

import { readdir, readFile, mkdir, writeFile } from 'fs/promises';
import { join, basename } from 'path';

const GEOLIFE_ROOT = join(import.meta.dirname, 'Geolife Trajectories 1.3', 'Data');
const OUTPUT_DIR = join(import.meta.dirname, 'processed');

// GeoLife timestamps are local Beijing time stored as if UTC.
// Beijing = UTC+8, so we need to interpret hours as local time.
// The .plt files contain local timestamps, but we parse them as UTC.
// To get local hour: just use getUTCHours() — it IS the local hour.
const LOCAL_TZ_OFFSET = 0; // timestamps already represent local time

// ============================================================
// 1. Parse a single .plt file
// ============================================================
function parsePlt(content) {
  const lines = content.split('\n');
  // First 6 lines are header
  const points = [];
  for (let i = 6; i < lines.length; i++) {
    const parts = lines[i].trim().split(',');
    if (parts.length < 7) continue;
    const lat = parseFloat(parts[0]);
    const lon = parseFloat(parts[1]);
    const date = parts[5]; // YYYY-MM-DD
    const time = parts[6]; // HH:MM:SS
    if (isNaN(lat) || isNaN(lon)) continue;
    // Skip obvious outliers
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    points.push({
      lat, lon,
      timestamp: `${date}T${time}`,
      ts: new Date(`${date}T${time}Z`).getTime(),
    });
  }
  return points;
}

// ============================================================
// 2. Haversine distance
// ============================================================
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1,
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2
  );
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ============================================================
// 3. Extract home location (most frequent nighttime cluster)
// ============================================================
function extractHome(points) {
  // Nighttime points: 22:00 - 06:00
  const nightPoints = points.filter(p => {
    const h = new Date(p.ts).getUTCHours();
    return h >= 22 || h < 6;
  });

  if (nightPoints.length < 10) return null;

  // Simple grid-based clustering (0.005° ≈ 500m cells)
  const cellSize = 0.005;
  const cells = new Map();
  for (const p of nightPoints) {
    const key = `${Math.floor(p.lat / cellSize)},${Math.floor(p.lon / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  }

  // Find largest cluster
  let maxCell = null;
  let maxCount = 0;
  for (const [key, pts] of cells) {
    if (pts.length > maxCount) {
      maxCount = pts.length;
      maxCell = pts;
    }
  }

  if (!maxCell || maxCell.length < 5) return null;

  // Centroid of largest cluster
  const lat = maxCell.reduce((s, p) => s + p.lat, 0) / maxCell.length;
  const lon = maxCell.reduce((s, p) => s + p.lon, 0) / maxCell.length;
  return { lat, lon, nightPoints: maxCell.length };
}

// ============================================================
// 4. Extract work location (most frequent weekday daytime cluster)
// ============================================================
function extractWork(points, home) {
  // Weekday 09:00-17:00
  const workPoints = points.filter(p => {
    const d = new Date(p.ts);
    const day = d.getUTCDay();
    const h = d.getUTCHours();
    return day >= 1 && day <= 5 && h >= 9 && h < 17;
  });

  if (workPoints.length < 10) return null;

  const cellSize = 0.005;
  const cells = new Map();
  for (const p of workPoints) {
    const key = `${Math.floor(p.lat / cellSize)},${Math.floor(p.lon / cellSize)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  }

  // Find largest cluster that is > 500m from home
  const sorted = [...cells.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [key, pts] of sorted) {
    if (pts.length < 5) break;
    const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
    if (home && haversine(lat, lon, home.lat, home.lon) > 500) {
      return { lat, lon, workPoints: pts.length };
    }
  }
  return null;
}

// ============================================================
// 5. Resample to hourly observations
// ============================================================
function resampleHourly(points, days = 90) {
  if (points.length === 0) return [];

  // Sort by timestamp
  points.sort((a, b) => a.ts - b.ts);
  const timestamps = points.map(p => p.ts);

  const msPerDay = 86400000;
  const windowMs = days * msPerDay;
  const startTs = timestamps[0];
  const endTs = timestamps[timestamps.length - 1];

  // Binary search helper
  const lowerBound = (arr, val) => {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; arr[mid] < val ? lo = mid + 1 : hi = mid; }
    return lo;
  };

  // Sliding window with two pointers to find best 90-day window
  let bestStart = startTs;
  let bestCount = 0;
  const step = msPerDay;
  for (let ws = startTs; ws + windowMs <= endTs; ws += step) {
    const lo = lowerBound(timestamps, ws);
    const hi = lowerBound(timestamps, ws + windowMs);
    const count = hi - lo;
    if (count > bestCount) { bestCount = count; bestStart = ws; }
  }

  const windowEnd = bestStart + windowMs;
  const wLo = lowerBound(timestamps, bestStart);
  const wHi = lowerBound(timestamps, windowEnd);
  const windowPoints = points.slice(wLo, wHi);
  const windowTs = timestamps.slice(wLo, wHi);

  // Resample: for each hour, binary search for nearest point within ±30min
  const hourly = [];
  const msPerHour = 3600000;
  const halfHour = msPerHour / 2;
  const startDate = new Date(bestStart);
  startDate.setUTCMinutes(0, 0, 0);

  for (let t = startDate.getTime(); t < windowEnd; t += msPerHour) {
    // Binary search for closest point
    let idx = lowerBound(windowTs, t);
    let nearest = null;
    let minDist = halfHour;
    // Check idx and idx-1
    for (let i = Math.max(0, idx - 1); i <= Math.min(windowTs.length - 1, idx + 1); i++) {
      const dt = Math.abs(windowTs[i] - t);
      if (dt < minDist) { minDist = dt; nearest = windowPoints[i]; }
    }
    if (nearest) {
      const d = new Date(t);
      hourly.push({
        lat: nearest.lat,
        lon: nearest.lon,
        timestamp: d.toISOString(),
        hour: d.getUTCHours(),
        day: Math.floor((t - bestStart) / msPerDay),
        isWeekend: d.getUTCDay() === 0 || d.getUTCDay() === 6,
      });
    }
  }

  return hourly;
}

// ============================================================
// Main
// ============================================================
async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  let userDirs;
  try {
    userDirs = await readdir(GEOLIFE_ROOT);
  } catch (e) {
    console.error(`Cannot read GeoLife data at ${GEOLIFE_ROOT}`);
    console.error('Make sure the dataset is extracted at eval/geolife/Geolife Trajectories 1.3/');
    process.exit(1);
  }

  // Sort numerically
  userDirs = userDirs.filter(d => /^\d+$/.test(d)).sort((a, b) => parseInt(a) - parseInt(b));
  console.log(`Found ${userDirs.length} users`);

  const userMeta = [];
  let processed = 0;
  let skipped = 0;

  for (const userId of userDirs) {
    const trajDir = join(GEOLIFE_ROOT, userId, 'Trajectory');
    let files;
    try {
      files = (await readdir(trajDir)).filter(f => f.endsWith('.plt'));
    } catch {
      skipped++;
      continue;
    }

    // Parse all trajectories for this user
    const allPoints = [];
    for (const file of files) {
      const content = await readFile(join(trajDir, file), 'utf-8');
      allPoints.push(...parsePlt(content));
    }

    if (allPoints.length < 50) {
      skipped++;
      continue;
    }

    // Extract home
    const home = extractHome(allPoints);
    if (!home) {
      skipped++;
      continue;
    }

    // Extract work (optional — many users don't have clear work patterns)
    const work = extractWork(allPoints, home);

    // Resample to hourly
    const hourly = resampleHourly(allPoints, 90);
    if (hourly.length < 100) {
      skipped++;
      continue;
    }

    // Count coverage: how many of the 2160 hours (90 days) have data?
    const coverage = hourly.length / (90 * 24);

    const meta = {
      userId,
      totalPoints: allPoints.length,
      hourlyPoints: hourly.length,
      coverage: Math.round(coverage * 100) / 100,
      home: { lat: home.lat, lon: home.lon },
      work: work ? { lat: work.lat, lon: work.lon } : null,
      homeWorkDistM: work ? Math.round(haversine(home.lat, home.lon, work.lat, work.lon)) : null,
    };

    userMeta.push(meta);

    // Save hourly trace
    await writeFile(
      join(OUTPUT_DIR, `${userId}.json`),
      JSON.stringify(hourly),
    );

    processed++;
    if (processed % 20 === 0) {
      console.log(`  Processed ${processed} users (${skipped} skipped)`);
    }
  }

  // Save user metadata
  await writeFile(
    join(OUTPUT_DIR, 'users.json'),
    JSON.stringify(userMeta, null, 2),
  );

  console.log(`\nDone: ${processed} users processed, ${skipped} skipped`);
  console.log(`Coverage stats:`);
  const coverages = userMeta.map(u => u.coverage);
  coverages.sort((a, b) => a - b);
  console.log(`  Median coverage: ${coverages[Math.floor(coverages.length / 2)]}`);
  console.log(`  Min: ${coverages[0]}, Max: ${coverages[coverages.length - 1]}`);
  console.log(`  Users with home+work: ${userMeta.filter(u => u.work).length}`);
  console.log(`  Average hourly points: ${Math.round(userMeta.reduce((s, u) => s + u.hourlyPoints, 0) / userMeta.length)}`);
}

main().catch(console.error);
