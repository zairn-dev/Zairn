/**
 * Geometric Accuracy Evaluation for Zairn-ZKP Circuit
 *
 * Evaluates the approximation error of fixed-point integer arithmetic
 * with cos(lat) longitude correction vs true haversine distance.
 *
 * No external dependencies — pure Node.js.
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCALE = 1_000_000n;
const SCALE_F = 1_000_000;
const EARTH_RADIUS_M = 6_371_000; // mean Earth radius in meters
const DEG_TO_RAD = Math.PI / 180;
const METERS_PER_DEG = 111_320; // approximate meters per degree of latitude

// ---------------------------------------------------------------------------
// Haversine (ground truth)
// ---------------------------------------------------------------------------

function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) *
      Math.cos(lat2 * DEG_TO_RAD) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// ---------------------------------------------------------------------------
// Circuit math (pure BigInt, mirrors circom exactly)
// ---------------------------------------------------------------------------

function circuitDistSquared(targetLatDeg, targetLonDeg, userLatDeg, userLonDeg) {
  const targetLat = BigInt(Math.round(targetLatDeg * SCALE_F));
  const targetLon = BigInt(Math.round(targetLonDeg * SCALE_F));
  const userLat = BigInt(Math.round(userLatDeg * SCALE_F));
  const userLon = BigInt(Math.round(userLonDeg * SCALE_F));

  const dLat = targetLat > userLat ? targetLat - userLat : userLat - targetLat;
  const dLon = targetLon > userLon ? targetLon - userLon : userLon - targetLon;

  const cosLatScaled = BigInt(
    Math.round(Math.cos(targetLatDeg * DEG_TO_RAD) * SCALE_F)
  );

  const dLonCorrected = (dLon * cosLatScaled) / SCALE;

  return dLat * dLat + dLonCorrected * dLonCorrected;
}

function circuitRadiusSquared(radiusMeters) {
  // radius in fixed-point degree units, then squared
  const rScaled = BigInt(Math.round((radiusMeters / METERS_PER_DEG) * SCALE_F));
  return rScaled * rScaled;
}

/** Convert circuit distSquared back to an effective distance in meters */
function circuitDistToMeters(distSq) {
  // distSq is in (degree * SCALE)^2 units
  // sqrt gives degree * SCALE, then / SCALE * METERS_PER_DEG
  const dist = Math.sqrt(Number(distSq));
  return (dist / SCALE_F) * METERS_PER_DEG;
}

// ---------------------------------------------------------------------------
// Point generation — move `distance` meters from (lat, lon) along `bearing`
// ---------------------------------------------------------------------------

function movePoint(lat, lon, distanceMeters, bearingDeg) {
  const brng = bearingDeg * DEG_TO_RAD;
  const lat1 = lat * DEG_TO_RAD;
  const lon1 = lon * DEG_TO_RAD;
  const d = distanceMeters / EARTH_RADIUS_M;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );

  return { lat: lat2 / DEG_TO_RAD, lon: lon2 / DEG_TO_RAD };
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const LATITUDES = [0, 15, 30, 35.66, 45, 60, 75, 85];
const RADII = [25, 50, 100, 200, 500];
const DIRECTIONS = [
  { name: "N", bearing: 0 },
  { name: "NE", bearing: 45 },
  { name: "E", bearing: 90 },
  { name: "SE", bearing: 135 },
  { name: "S", bearing: 180 },
  { name: "SW", bearing: 225 },
  { name: "W", bearing: 270 },
  { name: "NW", bearing: 315 },
];
const OFFSETS = [-1, 0, 1]; // meters relative to exact boundary

// ---------------------------------------------------------------------------
// Run evaluation
// ---------------------------------------------------------------------------

const allResults = [];

for (const lat of LATITUDES) {
  const targetLat = lat;
  const targetLon = 139.0; // arbitrary reference longitude

  for (const radius of RADII) {
    const rSq = circuitRadiusSquared(radius);

    for (const dir of DIRECTIONS) {
      for (const offset of OFFSETS) {
        const testDist = radius + offset;
        const pt = movePoint(targetLat, targetLon, testDist, dir.bearing);

        const trueDist = haversine(targetLat, targetLon, pt.lat, pt.lon);
        const cDistSq = circuitDistSquared(targetLat, targetLon, pt.lat, pt.lon);
        const circuitDist = circuitDistToMeters(cDistSq);
        const circuitAccepts = cDistSq <= rSq;

        // Haversine-based accept/reject (using same threshold)
        const haversineAccepts = trueDist <= radius;

        const errorMeters = circuitDist - trueDist;

        allResults.push({
          latitude: lat,
          radius,
          direction: dir.name,
          offsetFromBoundary: offset,
          testDistanceMeters: testDist,
          haversineDistMeters: +trueDist.toFixed(6),
          circuitDistMeters: +circuitDist.toFixed(6),
          errorMeters: +errorMeters.toFixed(6),
          absErrorMeters: +Math.abs(errorMeters).toFixed(6),
          circuitAccepts,
          haversineAccepts,
          boundaryMatch: circuitAccepts === haversineAccepts,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

// Per-latitude max absolute error
const perLatError = {};
for (const r of allResults) {
  const key = r.latitude;
  if (!perLatError[key] || r.absErrorMeters > perLatError[key].maxAbsError) {
    perLatError[key] = {
      maxAbsError: r.absErrorMeters,
      atRadius: r.radius,
      atDirection: r.direction,
      atOffset: r.offsetFromBoundary,
    };
  }
}

// Per-latitude boundary accuracy
const perLatBoundary = {};
for (const r of allResults) {
  const key = r.latitude;
  if (!perLatBoundary[key]) {
    perLatBoundary[key] = { total: 0, matches: 0, mismatches: [] };
  }
  perLatBoundary[key].total++;
  if (r.boundaryMatch) {
    perLatBoundary[key].matches++;
  } else {
    perLatBoundary[key].mismatches.push({
      radius: r.radius,
      direction: r.direction,
      offset: r.offsetFromBoundary,
      haversineDist: r.haversineDistMeters,
      circuitDist: r.circuitDistMeters,
      error: r.errorMeters,
    });
  }
}

// Per (latitude, radius) max error
const perLatRadius = {};
for (const r of allResults) {
  const key = `${r.latitude}|${r.radius}`;
  if (!perLatRadius[key] || r.absErrorMeters > perLatRadius[key]) {
    perLatRadius[key] = r.absErrorMeters;
  }
}

// Find first combination where error exceeds 1m
const exceedsOneM = [];
for (const [key, err] of Object.entries(perLatRadius)) {
  if (err > 1.0) {
    const [lat, rad] = key.split("|").map(Number);
    exceedsOneM.push({ latitude: lat, radius: rad, maxErrorMeters: err });
  }
}
exceedsOneM.sort((a, b) => a.maxErrorMeters - b.maxErrorMeters);

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

console.log("=".repeat(80));
console.log("Zairn-ZKP Circuit Geometric Accuracy Evaluation");
console.log(`Date: 2026-03-16`);
console.log("=".repeat(80));

// Table 1: Per-latitude max error
console.log("\n--- Per-Latitude Maximum Absolute Error ---\n");
console.log(
  "Latitude     Max Error (m)   At Radius   Direction   Offset"
);
console.log("-".repeat(65));
for (const lat of LATITUDES) {
  const e = perLatError[lat];
  console.log(
    `${String(lat).padEnd(12)} ${e.maxAbsError.toFixed(4).padStart(13)}   ${String(e.atRadius + "m").padEnd(9)}   ${e.atDirection.padEnd(9)}   ${e.atOffset >= 0 ? "+" : ""}${e.atOffset}m`
  );
}

// Table 2: Per-latitude boundary accuracy
console.log("\n--- Per-Latitude Boundary Accuracy (accept/reject match with haversine) ---\n");
console.log("Latitude     Accuracy       Mismatches");
console.log("-".repeat(50));
for (const lat of LATITUDES) {
  const b = perLatBoundary[lat];
  const pct = ((b.matches / b.total) * 100).toFixed(1);
  console.log(
    `${String(lat).padEnd(12)} ${(pct + "%").padStart(7)}        ${b.total - b.matches}/${b.total}`
  );
}

// Table 3: Per (latitude, radius) max error grid
console.log("\n--- Max Error (meters) by Latitude x Radius ---\n");
const header =
  "Latitude    " + RADII.map((r) => `${r}m`.padStart(10)).join("");
console.log(header);
console.log("-".repeat(header.length));
for (const lat of LATITUDES) {
  const cells = RADII.map((r) => {
    const err = perLatRadius[`${lat}|${r}`];
    const s = err.toFixed(4);
    return (err > 1.0 ? `*${s}` : ` ${s}`).padStart(10);
  }).join("");
  console.log(`${String(lat).padEnd(12)}${cells}`);
}
console.log("\n(* = error exceeds 1 meter)");

// Table 4: Where error exceeds 1m
if (exceedsOneM.length > 0) {
  console.log("\n--- Combinations Where Error Exceeds 1m ---\n");
  console.log("Latitude     Radius    Max Error (m)");
  console.log("-".repeat(40));
  for (const e of exceedsOneM) {
    console.log(
      `${String(e.latitude).padEnd(12)} ${String(e.radius + "m").padEnd(9)} ${e.maxErrorMeters.toFixed(4)}`
    );
  }
} else {
  console.log("\n--- No combinations exceed 1m error. ---");
}

// Mismatch details
let totalMismatches = 0;
for (const lat of LATITUDES) {
  totalMismatches += perLatBoundary[lat].mismatches.length;
}
if (totalMismatches > 0) {
  console.log(`\n--- Boundary Mismatch Details (${totalMismatches} total) ---\n`);
  for (const lat of LATITUDES) {
    const mm = perLatBoundary[lat].mismatches;
    if (mm.length === 0) continue;
    console.log(`  Latitude ${lat}°:`);
    for (const m of mm.slice(0, 10)) {
      console.log(
        `    r=${m.radius}m ${m.direction} offset=${m.offset >= 0 ? "+" : ""}${m.offset}m  ` +
          `haversine=${m.haversineDist.toFixed(3)}m  circuit=${m.circuitDist.toFixed(3)}m  err=${m.error.toFixed(3)}m`
      );
    }
    if (mm.length > 10) console.log(`    ... and ${mm.length - 10} more`);
  }
}

console.log("\n" + "=".repeat(80));
console.log(`Total test points: ${allResults.length}`);
console.log(`Boundary mismatches: ${totalMismatches}/${allResults.length}`);
console.log("=".repeat(80));

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------

const outputPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "geometric-accuracy-results-2026-03-16.json"
);

const jsonOutput = {
  metadata: {
    date: "2026-03-16",
    description:
      "Geometric accuracy evaluation of Zairn-ZKP circuit (fixed-point cos(lat) correction vs haversine)",
    scale: Number(SCALE),
    metersPerDeg: METERS_PER_DEG,
    earthRadiusM: EARTH_RADIUS_M,
    latitudes: LATITUDES,
    radii: RADII,
    directions: DIRECTIONS.map((d) => d.name),
    offsets: OFFSETS,
    totalTestPoints: allResults.length,
  },
  summary: {
    perLatitudeMaxError: Object.fromEntries(
      LATITUDES.map((lat) => [lat, perLatError[lat]])
    ),
    perLatitudeBoundaryAccuracy: Object.fromEntries(
      LATITUDES.map((lat) => {
        const b = perLatBoundary[lat];
        return [
          lat,
          {
            accuracy: +(b.matches / b.total).toFixed(4),
            matches: b.matches,
            total: b.total,
            mismatchCount: b.total - b.matches,
          },
        ];
      })
    ),
    perLatitudeRadiusMaxError: Object.fromEntries(
      Object.entries(perLatRadius).map(([k, v]) => {
        const [lat, rad] = k.split("|").map(Number);
        return [k, { latitude: lat, radius: rad, maxErrorMeters: v }];
      })
    ),
    combinationsExceeding1m: exceedsOneM,
    totalBoundaryMismatches: totalMismatches,
  },
  results: allResults,
};

writeFileSync(outputPath, JSON.stringify(jsonOutput, null, 2));
console.log(`\nFull results written to:\n  ${outputPath}`);
