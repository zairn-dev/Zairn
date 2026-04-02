/**
 * Geofence verification
 * Logic to verify whether a user is actually at a drop's location
 */
import type { LocationProof } from './types';

// Distance calculation using the Haversine formula (in meters)
export function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(1,
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2));
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Geohash encoding
const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export function encodeGeohash(lat: number, lon: number, precision: number = 7): string {
  let minLat = -90, maxLat = 90, minLon = -180, maxLon = 180;
  let isLon = true, bits = 0, hashVal = 0;
  let result = '';

  while (result.length < precision) {
    const mid = isLon ? (minLon + maxLon) / 2 : (minLat + maxLat) / 2;
    if (isLon) {
      if (lon >= mid) { hashVal = hashVal * 2 + 1; minLon = mid; }
      else { hashVal = hashVal * 2; maxLon = mid; }
    } else {
      if (lat >= mid) { hashVal = hashVal * 2 + 1; minLat = mid; }
      else { hashVal = hashVal * 2; maxLat = mid; }
    }
    isLon = !isLon;
    bits++;
    if (bits === 5) {
      result += GEOHASH_BASE32[hashVal];
      bits = 0;
      hashVal = 0;
    }
  }
  return result;
}

export function decodeGeohash(geohash: string): { lat: number; lon: number } {
  let minLat = -90, maxLat = 90, minLon = -180, maxLon = 180;
  let isLon = true;

  for (const ch of geohash) {
    const val = GEOHASH_BASE32.indexOf(ch);
    if (val === -1) break;
    for (let bit = 4; bit >= 0; bit--) {
      const mid = isLon ? (minLon + maxLon) / 2 : (minLat + maxLat) / 2;
      if (isLon) {
        if (val & (1 << bit)) minLon = mid; else maxLon = mid;
      } else {
        if (val & (1 << bit)) minLat = mid; else maxLat = mid;
      }
      isLon = !isLon;
    }
  }
  return { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
}

/**
 * Location verification parameters
 */
export interface VerifyOptions {
  /** Drop latitude */
  targetLat: number;
  /** Drop longitude */
  targetLon: number;
  /** Unlock radius (meters) */
  unlockRadius: number;
  /** User latitude */
  userLat: number;
  /** User longitude */
  userLon: number;
  /** GPS accuracy (meters) */
  accuracy: number;
  /** User ID */
  userId: string;
}

/**
 * Perform geofence verification
 *
 * Verification logic:
 * 1. Calculate distance between user and drop
 * 2. Determine effective distance accounting for GPS accuracy
 * 3. Verified if within radius
 */
export function verifyProximity(opts: VerifyOptions): LocationProof {
  const distance = calculateDistance(
    opts.targetLat, opts.targetLon,
    opts.userLat, opts.userLon
  );

  // Account for GPS accuracy: actual distance is within +/- accuracy range
  // Cap accuracy to prevent manipulation (e.g., sending accuracy=499 to unlock from far away)
  // Max effective accuracy is 50m or half the unlock radius, whichever is smaller
  const maxAccuracy = Math.min(50, opts.unlockRadius / 2);
  const effectiveAccuracy = Math.min(opts.accuracy, maxAccuracy);
  const verified = (distance - effectiveAccuracy) <= opts.unlockRadius;

  return {
    user_id: opts.userId,
    lat: opts.userLat,
    lon: opts.userLon,
    accuracy: opts.accuracy,
    timestamp: new Date().toISOString(),
    geohash: encodeGeohash(opts.userLat, opts.userLon),
    distance_to_target: Math.round(distance),
    verified,
  };
}

/**
 * Get the 8 adjacent geohash cells in all directions
 * Used in findNearbyDrops to search for drops across cell boundaries
 */
export function geohashNeighbors(geohash: string): string[] {
  if (!geohash) return [];
  const { lat, lon } = decodeGeohash(geohash);

  // Approximate cell size based on geohash precision
  // precision: lat half-width, lon half-width
  const precisionSizes: Record<number, { dlat: number; dlon: number }> = {
    1: { dlat: 23, dlon: 23 },
    2: { dlat: 2.8, dlon: 5.6 },
    3: { dlat: 0.7, dlon: 0.7 },
    4: { dlat: 0.087, dlon: 0.175 },
    5: { dlat: 0.022, dlon: 0.022 },
    6: { dlat: 0.0027, dlon: 0.0055 },
    7: { dlat: 0.00068, dlon: 0.00068 },
    8: { dlat: 0.000085, dlon: 0.00017 },
  };

  const precision = geohash.length;
  const size = precisionSizes[precision] || precisionSizes[7];
  // Use 2x step to reach center of neighbor cells
  const step = { dlat: size.dlat * 2, dlon: size.dlon * 2 };

  const directions = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],           [0, 1],
    [1, -1],  [1, 0],  [1, 1],
  ];

  const neighbors: string[] = [];
  for (const [dy, dx] of directions) {
    const nLat = lat + dy * step.dlat;
    let nLon = lon + dx * step.dlon;
    // Clamp latitude (poles)
    if (nLat < -90 || nLat > 90) continue;
    // Wrap longitude across antimeridian (±180°)
    if (nLon > 180) nLon -= 360;
    else if (nLon < -180) nLon += 360;
    const h = encodeGeohash(nLat, nLon, precision);
    if (h !== geohash && !neighbors.includes(h)) {
      neighbors.push(h);
    }
  }
  return neighbors;
}

/**
 * Movement speed plausibility check
 * Verifies whether the speed between the previous and current location is realistic
 */
export function isMovementRealistic(
  prevLat: number, prevLon: number, prevTimestamp: string,
  currLat: number, currLon: number, currTimestamp: string
): boolean {
  const distance = calculateDistance(prevLat, prevLon, currLat, currLon);
  const timeDiffMs = new Date(currTimestamp).getTime() - new Date(prevTimestamp).getTime();
  if (timeDiffMs <= 0) return false;

  const speedMs = distance / (timeDiffMs / 1000);
  // Max speed: 300 m/s (approx. 1080 km/h = airplane level)
  // Movement exceeding this is likely GPS spoofing
  return speedMs <= 300;
}
