import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const circuitsDir = path.join(packageRoot, 'circuits');
const buildDir = path.join(circuitsDir, 'build');

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.min(
    1,
    Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  );
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function verifyGps(drop, submission) {
  const distance = calculateDistance(drop.lat, drop.lon, submission.lat, submission.lon);
  const maxAccuracy = Math.min(50, drop.unlock_radius_meters / 2);
  const effectiveAccuracy = Math.min(submission.accuracy, maxAccuracy);
  return (distance - effectiveAccuracy) <= drop.unlock_radius_meters;
}

function validatePublicSignals(publicSignals, drop) {
  const targetLat = String(Math.round(drop.lat * 1_000_000));
  const targetLon = String(Math.round(drop.lon * 1_000_000));
  const rDeg = drop.unlock_radius_meters / 111_320;
  const rFp = BigInt(Math.round(rDeg * 1_000_000));
  const radiusSquared = String(rFp * rFp);
  const cosLatScaled = String(BigInt(Math.round(Math.cos(drop.lat * Math.PI / 180) * 1_000_000)));
  const expected = ['1', targetLat, targetLon, radiusSquared, cosLatScaled];
  return expected.every((value, index) => publicSignals[index] === value);
}

async function main() {
  const verificationKey = JSON.parse(await readFile(path.join(circuitsDir, 'verification_key.json'), 'utf8'));
  const proof = JSON.parse(await readFile(path.join(buildDir, 'zairn_zkp_proof.json'), 'utf8'));
  const publicSignals = JSON.parse(await readFile(path.join(buildDir, 'zairn_zkp_public.json'), 'utf8'));

  const drop = {
    id: 'drop-1',
    creator_id: 'creator-1',
    lat: 35.6812,
    lon: 139.7671,
    geohash: 'xn77h3c',
    unlock_radius_meters: 50,
    title: 'Latency Drop',
    description: null,
    content_type: 'text',
    ipfs_cid: 'QmTest',
    encrypted_content: null,
    encrypted: true,
    encryption_salt: 'salt',
    visibility: 'public',
    password_hash: null,
    max_claims: null,
    claim_count: 0,
    proof_config: null,
    expires_at: null,
    status: 'active',
    preview_url: null,
    metadata: null,
    created_at: '2026-03-13T00:00:00Z',
    updated_at: '2026-03-13T00:00:00Z',
  };

  const gpsSubmission = { lat: 35.68125, lon: 139.76715, accuracy: 10, user_id: 'u1' };

  const gpsTimes = [];
  for (let i = 0; i < 1000; i += 1) {
    const start = performance.now();
    const result = verifyGps(drop, gpsSubmission);
    gpsTimes.push(performance.now() - start);
    if (!result) throw new Error('GPS verification unexpectedly failed');
  }

  const zkpTimes = [];
  for (let i = 0; i < 10; i += 1) {
    const start = performance.now();
    const signalsOk = validatePublicSignals(publicSignals, drop);
    const result = signalsOk && await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
    zkpTimes.push(performance.now() - start);
    if (!result) throw new Error('ZKP verification unexpectedly failed');
  }

  const nearBoundary = verifyGps(drop, { lat: 35.681649, lon: 139.7671, accuracy: 0, user_id: 'u1' });
  const outsideBoundary = verifyGps(drop, { lat: 35.681651, lon: 139.7671, accuracy: 0, user_id: 'u1' });

  console.log('Zairn-ZKP unlock-path latency snapshot');
  console.log(`GPS engine latency avg over 1000 runs: ${average(gpsTimes).toFixed(4)} ms`);
  console.log(`ZKP engine latency avg over 10 runs: ${average(zkpTimes).toFixed(2)} ms`);
  console.log(`GPS boundary case (inside): ${nearBoundary ? 'accepted' : 'rejected'}`);
  console.log(`GPS boundary case (outside): ${outsideBoundary ? 'accepted' : 'rejected'}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
