// Smoke test: zanzo burial CID → @zairn/geo-drop drop record + geofence verification.
//
// Pure logic only — no Supabase, no chain. Demonstrates the integration
// contract: zanzo emits a burial CID, geo-drop wraps it in a Drop with a
// location + radius, then verifyProximity checks whether a visitor's
// reported GPS fix would unlock the drop.
//
// Run after building the package: `pnpm --filter @zairn/geo-drop build`.

import { verifyProximity, encodeGeohash, calculateDistance } from '../dist/geofence.js';

// 1. Simulated zanzo burial output (real CID from the kubo test earlier).
const burial = {
  status: 'pinned',
  pinning_service: 'kubo_local',
  cid: 'bafybeiceggupd6akniv2aitoslel4zmua5qh3a7q37luxvris4kx3qalcy',
  size_bytes: 1307285,
};

// 2. The drop the curator would register for this CID. Location is a
//    coarsened bury-point near the exhibition venue (Roppongi, Tokyo).
const drop = {
  title: 'Residual Places — Sample 04e93c',
  content_type: 'image',
  ipfs_cid: burial.cid,
  lat: 35.6627,
  lon: 139.7311,
  unlock_radius_meters: 50,
  geohash: encodeGeohash(35.6627, 139.7311),
};

console.log('--- drop record (would be persisted to Supabase) ---');
console.log(JSON.stringify(drop, null, 2));

// 3. Two visitors: one at the drop (~5m off), one across town.
const onsite = { userId: 'visitor_a', lat: 35.6628, lon: 139.7312, accuracy: 8 };
const offsite = { userId: 'visitor_b', lat: 35.6895, lon: 139.6917, accuracy: 12 };

for (const v of [onsite, offsite]) {
  const proof = verifyProximity({
    targetLat: drop.lat,
    targetLon: drop.lon,
    unlockRadius: drop.unlock_radius_meters,
    userLat: v.lat,
    userLon: v.lon,
    accuracy: v.accuracy,
    userId: v.userId,
  });
  const dKm = (calculateDistance(drop.lat, drop.lon, v.lat, v.lon) / 1000).toFixed(2);
  console.log(`\n--- ${v.userId} (distance ${dKm} km) ---`);
  console.log(JSON.stringify(proof, null, 2));
}
