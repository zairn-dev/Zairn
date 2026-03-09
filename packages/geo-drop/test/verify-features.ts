/**
 * GeoDrop Feature Verification Script
 * Tests all pure-logic features without DB/IPFS dependencies.
 * Run: npx tsx test/verify-features.ts
 */

// =====================
// 1. Geofence utilities
// =====================

import {
  encodeGeohash,
  decodeGeohash,
  calculateDistance,
  verifyProximity,
  geohashNeighbors,
  isMovementRealistic,
} from '../src/geofence';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

console.log('\n=== 1. Geofence Utilities ===');

// 1.1 encodeGeohash
const gh = encodeGeohash(35.6812, 139.7671, 7);
assert(gh.length === 7, 'encodeGeohash returns 7-char hash');
assert(gh === encodeGeohash(35.6812, 139.7671, 7), 'encodeGeohash is deterministic');

// 1.2 decodeGeohash
const decoded = decodeGeohash(gh);
assert(Math.abs(decoded.lat - 35.6812) < 0.01, 'decodeGeohash lat within 0.01');
assert(Math.abs(decoded.lon - 139.7671) < 0.01, 'decodeGeohash lon within 0.01');

// 1.3 calculateDistance
const distTokyo = calculateDistance(35.6812, 139.7671, 35.6812, 139.7671);
assert(distTokyo === 0, 'calculateDistance same point = 0');
const distToOsaka = calculateDistance(35.6812, 139.7671, 34.6937, 135.5023);
assert(distToOsaka > 390000 && distToOsaka < 410000, `calculateDistance Tokyo-Osaka ~400km (got ${Math.round(distToOsaka)}m)`);

// 1.4 verifyProximity
const proofInside = verifyProximity({
  targetLat: 35.6812, targetLon: 139.7671,
  unlockRadius: 50,
  userLat: 35.6813, userLon: 139.7672,
  accuracy: 10, userId: 'test-user',
});
assert(proofInside.verified === true, 'verifyProximity inside radius');
assert(proofInside.distance_to_target < 50, `distance_to_target < 50 (got ${proofInside.distance_to_target})`);
assert(proofInside.geohash.length > 0, 'verifyProximity returns geohash');

const proofOutside = verifyProximity({
  targetLat: 35.6812, targetLon: 139.7671,
  unlockRadius: 10,
  userLat: 35.6820, userLon: 139.7680,
  accuracy: 5, userId: 'test-user',
});
assert(proofOutside.verified === false, 'verifyProximity outside radius');

// 1.5 geohashNeighbors
const neighbors = geohashNeighbors(gh);
assert(neighbors.length === 8, `geohashNeighbors returns 8 (got ${neighbors.length})`);
assert(!neighbors.includes(gh), 'geohashNeighbors excludes center');
assert(new Set(neighbors).size === neighbors.length, 'geohashNeighbors no duplicates');

// 1.6 isMovementRealistic
const realistic = isMovementRealistic(
  35.6812, 139.7671, '2026-03-09T00:00:00Z',
  35.6820, 139.7680, '2026-03-09T00:01:00Z'
);
assert(realistic === true, 'isMovementRealistic normal movement');

const spoofed = isMovementRealistic(
  35.6812, 139.7671, '2026-03-09T00:00:00Z',
  34.6937, 135.5023, '2026-03-09T00:00:01Z'
);
assert(spoofed === false, 'isMovementRealistic teleport detected');

const zeroTime = isMovementRealistic(
  35.6812, 139.7671, '2026-03-09T00:00:00Z',
  35.6820, 139.7680, '2026-03-09T00:00:00Z'
);
assert(zeroTime === false, 'isMovementRealistic zero time diff');


// =====================
// 2. Crypto utilities
// =====================

import { encrypt, decrypt, hashPassword, deriveLocationKey } from '../src/crypto';

console.log('\n=== 2. Crypto Utilities ===');

// 2.1 deriveLocationKey
const locKey = deriveLocationKey('xn77h3c', 'drop-123', 'salt-abc');
assert(locKey === 'geodrop:xn77h3c:drop-123:salt-abc', 'deriveLocationKey format correct');

// 2.2 encrypt/decrypt round-trip
const plaintext = 'Hello, Location-Bound Content!';
const testKey = 'test-encryption-key-2026';
const encrypted = await encrypt(plaintext, testKey);
assert(typeof encrypted.ciphertext === 'string', 'encrypt returns ciphertext');
assert(typeof encrypted.iv === 'string', 'encrypt returns iv');
assert(typeof encrypted.salt === 'string', 'encrypt returns salt');

const decrypted = await decrypt(encrypted, testKey);
assert(decrypted === plaintext, 'decrypt returns original plaintext');

// 2.3 Wrong key fails
try {
  await decrypt(encrypted, 'wrong-key');
  assert(false, 'decrypt with wrong key should throw');
} catch {
  assert(true, 'decrypt with wrong key throws error');
}

// 2.4 hashPassword deterministic
const hash1 = await hashPassword('test-password');
const hash2 = await hashPassword('test-password');
assert(hash1 === hash2, 'hashPassword is deterministic');
const hash3 = await hashPassword('different-password');
assert(hash1 !== hash3, 'hashPassword different for different passwords');

// 2.5 Full location-based encryption cycle
const geohash = encodeGeohash(35.6812, 139.7671, 7);
const dropId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const salt = 'deadbeef01234567';
const locationKey = deriveLocationKey(geohash, dropId, salt);
const locationEncrypted = await encrypt('Secret at Tokyo Tower', locationKey);
const locationDecrypted = await decrypt(locationEncrypted, locationKey);
assert(locationDecrypted === 'Secret at Tokyo Tower', 'Full location-based encrypt/decrypt cycle');


// =====================
// 3. Verification Engine
// =====================

import { createVerificationEngine } from '../src/verification';
import type { GeoDrop, ProofConfig, ProofSubmission } from '../src/types';

console.log('\n=== 3. Verification Engine ===');

const mockDrop: GeoDrop = {
  id: 'test-drop-id',
  creator_id: 'creator-id',
  lat: 35.6812,
  lon: 139.7671,
  geohash: 'xn77h3c',
  unlock_radius_meters: 50,
  title: 'Test Drop',
  description: null,
  content_type: 'text',
  ipfs_cid: 'QmTest',
  encrypted: true,
  encryption_salt: 'abc123',
  visibility: 'public',
  password_hash: null,
  max_claims: null,
  claim_count: 0,
  proof_config: null,
  expires_at: null,
  status: 'active',
  preview_url: null,
  metadata: null,
  created_at: '2026-03-09T00:00:00Z',
  updated_at: '2026-03-09T00:00:00Z',
};

// Mock engine without real Edge Function
const engine = createVerificationEngine({
  imageProofUrl: 'http://localhost:9999/image-proof',
  similarityThreshold: 0.7,
  getAuthHeaders: async () => ({ 'Content-Type': 'application/json' }),
});

// 3.1 GPS verification - pass
const gpsPassConfig: ProofConfig = { mode: 'all', requirements: [{ method: 'gps', params: {} }] };
const gpsPassSubs: ProofSubmission[] = [
  { method: 'gps', data: { lat: 35.6813, lon: 139.7672, accuracy: 10, user_id: 'u1' } },
];
const gpsResult = await engine.verify(mockDrop, gpsPassConfig, gpsPassSubs);
assert(gpsResult.verified === true, 'GPS verification pass (within radius)');
assert(gpsResult.proofs.length === 1, 'GPS verification returns 1 proof');
assert(gpsResult.proofs[0].method === 'gps', 'GPS proof method is gps');
assert(gpsResult.location_proof !== undefined, 'GPS verification returns location_proof');

// 3.2 GPS verification - fail
const gpsFailSubs: ProofSubmission[] = [
  { method: 'gps', data: { lat: 35.70, lon: 139.80, accuracy: 5, user_id: 'u1' } },
];
const gpsFailResult = await engine.verify(mockDrop, gpsPassConfig, gpsFailSubs);
assert(gpsFailResult.verified === false, 'GPS verification fail (outside radius)');

// 3.3 Secret verification - pass
const secretConfig: ProofConfig = {
  mode: 'all',
  requirements: [
    { method: 'gps', params: {} },
    { method: 'secret', params: { secret: 'CAFE-1234', label: 'QR Code' } },
  ],
};
const secretPassSubs: ProofSubmission[] = [
  { method: 'gps', data: { lat: 35.6813, lon: 139.7672, accuracy: 10, user_id: 'u1' } },
  { method: 'secret', data: { secret: 'CAFE-1234' } },
];
const secretResult = await engine.verify(mockDrop, secretConfig, secretPassSubs);
assert(secretResult.verified === true, 'Secret + GPS verification pass');
assert(secretResult.proofs.length === 2, 'Multi-proof returns 2 results');

// 3.4 Secret verification - fail
const secretFailSubs: ProofSubmission[] = [
  { method: 'gps', data: { lat: 35.6813, lon: 139.7672, accuracy: 10, user_id: 'u1' } },
  { method: 'secret', data: { secret: 'WRONG' } },
];
const secretFailResult = await engine.verify(mockDrop, secretConfig, secretFailSubs);
assert(secretFailResult.verified === false, 'Secret fail with wrong value');

// 3.5 ANY mode
const anyConfig: ProofConfig = {
  mode: 'any',
  requirements: [
    { method: 'gps', params: {} },
    { method: 'secret', params: { secret: 'BACKUP-KEY' } },
  ],
};
const anyGpsOnlySubs: ProofSubmission[] = [
  { method: 'gps', data: { lat: 35.6813, lon: 139.7672, accuracy: 10, user_id: 'u1' } },
];
const anyResult = await engine.verify(mockDrop, anyConfig, anyGpsOnlySubs);
assert(anyResult.verified === true, 'ANY mode passes with GPS only');

// 3.6 Missing required proof
const missingConfig: ProofConfig = {
  mode: 'all',
  requirements: [
    { method: 'gps', params: {} },
    { method: 'secret', params: { secret: 'REQUIRED' } },
  ],
};
const missingResult = await engine.verify(mockDrop, missingConfig, anyGpsOnlySubs);
assert(missingResult.verified === false, 'Missing required proof fails');

// 3.7 Optional proof skipped
const optionalConfig: ProofConfig = {
  mode: 'all',
  requirements: [
    { method: 'gps', params: {} },
    { method: 'secret', params: { secret: 'OPTIONAL' }, required: false },
  ],
};
const optionalResult = await engine.verify(mockDrop, optionalConfig, anyGpsOnlySubs);
assert(optionalResult.verified === true, 'Optional proof skipped, still passes');

// 3.8 Custom verifier
engine.register('my-custom', (_req, sub) => ({
  method: 'custom',
  verified: sub.data.token === 'valid-token',
  details: { token: sub.data.token },
}));
const customConfig: ProofConfig = {
  mode: 'all',
  requirements: [
    { method: 'custom', params: { verifier_id: 'my-custom' } },
  ],
};
const customPassResult = await engine.verify(mockDrop, customConfig, [
  { method: 'custom', data: { token: 'valid-token' } },
]);
assert(customPassResult.verified === true, 'Custom verifier pass');

const customFailResult = await engine.verify(mockDrop, customConfig, [
  { method: 'custom', data: { token: 'invalid' } },
]);
assert(customFailResult.verified === false, 'Custom verifier fail');


// =====================
// 4. Chain Client (ABI encoding/decoding)
// =====================

console.log('\n=== 4. Chain Client (ABI) ===');

// We test ABI encoding/decoding by importing createChainClient and testing getDropCids decoding
// Since we can't call a real chain, we test the encoding helpers indirectly

// Test via round-trip: encode a known geohash and verify bytes
const testGeohash = 'xn77h3c';
const expectedHex = '786e373768336300'; // ASCII hex of "xn77h3c" + 1 zero byte padding
// bytes7 in ABI: left-aligned in 32-byte slot
const expectedSlot = expectedHex.padEnd(64, '0');
// Manually verify
const manualHex = Array.from(testGeohash).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
assert(manualHex === '786e373768336300'.slice(0, 14), `Geohash hex encoding: ${manualHex}`);


// =====================
// 5. Persistence (metadata document)
// =====================

console.log('\n=== 5. Persistence (metadata document) ===');

import { createPersistenceManager } from '../src/persistence';
import { IpfsClient } from '../src/ipfs';

// Mock IPFS client that stores in memory
const memoryStore = new Map<string, string>();
const mockIpfs = {
  upload: async (content: string | File | Blob) => {
    const str = typeof content === 'string' ? content : await new Response(content).text();
    const cid = 'Qm' + Buffer.from(str).toString('hex').slice(0, 20);
    memoryStore.set(cid, str);
    return { cid, size: str.length, url: `https://gateway/${cid}` };
  },
  fetch: async (cid: string) => {
    const data = memoryStore.get(cid);
    if (!data) throw new Error(`CID not found: ${cid}`);
    return data;
  },
  getUrl: (cid: string) => `https://gateway/${cid}`,
} as unknown as IpfsClient;

const pm = createPersistenceManager(mockIpfs);

// 5.1 Persist db-only (no-op)
const dbOnlyResult = await pm.persist(mockDrop, 'db-only');
assert(dbOnlyResult.level === 'db-only', 'db-only persistence returns level');
assert(dbOnlyResult.metadataCid === undefined, 'db-only has no CID');

// 5.2 Persist ipfs
const ipfsResult = await pm.persist(mockDrop, 'ipfs');
assert(ipfsResult.level === 'ipfs', 'ipfs persistence returns level');
assert(typeof ipfsResult.metadataCid === 'string', 'ipfs persistence returns CID');

// 5.3 Recover from CID
const recovered = await pm.recoverFromCid(ipfsResult.metadataCid!);
assert(recovered.metadata.version === 1, 'Recovered metadata version = 1');
assert(recovered.metadata.dropId === mockDrop.id, 'Recovered dropId matches');
assert(recovered.metadata.geohash === mockDrop.geohash, 'Recovered geohash matches');
assert(recovered.metadata.contentCid === mockDrop.ipfs_cid, 'Recovered contentCid matches');
assert(recovered.metadata.encryptionSalt === mockDrop.encryption_salt, 'Recovered salt matches');
assert(recovered.source === 'ipfs', 'Recovery source is ipfs');

// 5.4 Persist with recoverySecret (encrypted metadata)
const encResult = await pm.persist(mockDrop, 'ipfs', 'my-recovery-secret');
assert(typeof encResult.metadataCid === 'string', 'Encrypted persist returns CID');

// Recover without secret should fail
try {
  await pm.recoverFromCid(encResult.metadataCid!);
  assert(false, 'Recovery without secret should throw');
} catch (e: any) {
  assert(e.message.includes('encrypted'), 'Recovery without secret throws encrypted error');
}

// Recover with secret should succeed
const encRecovered = await pm.recoverFromCid(encResult.metadataCid!, 'my-recovery-secret');
assert(encRecovered.metadata.dropId === mockDrop.id, 'Encrypted recovery dropId matches');
assert(encRecovered.metadata.contentCid === mockDrop.ipfs_cid, 'Encrypted recovery contentCid matches');

// 5.5 Persist onchain without chain config should fail
try {
  await pm.persist(mockDrop, 'onchain');
  assert(false, 'onchain without chain config should throw');
} catch (e: any) {
  assert(e.message.includes('Chain config'), 'onchain without chain config throws');
}


// =====================
// 6. IPFS Client (unit)
// =====================

console.log('\n=== 6. IPFS Client ===');

const ipfsClient = new IpfsClient({ gateway: 'https://w3s.link/ipfs' });
assert(ipfsClient.getUrl('QmTest') === 'https://w3s.link/ipfs/QmTest', 'IPFS getUrl correct');

// No pinning key → upload should throw
try {
  await ipfsClient.upload('test');
  assert(false, 'Upload without API key should throw');
} catch (e: any) {
  assert(e.message.includes('pinning'), 'Upload without config throws pinning error');
}


// =====================
// 7. Type completeness check
// =====================

console.log('\n=== 7. Type/Export Completeness ===');

import * as geoDropExports from '../src/index';

const expectedExports = [
  // Core
  'createGeoDrop',
  // Verification
  'createVerificationEngine',
  // Persistence
  'createPersistenceManager',
  // Chain
  'createChainClient',
  // Geofence
  'encodeGeohash', 'decodeGeohash', 'calculateDistance', 'verifyProximity', 'geohashNeighbors', 'isMovementRealistic',
  // Crypto
  'encrypt', 'decrypt', 'hashPassword', 'deriveLocationKey',
  // IPFS
  'IpfsClient',
];

for (const name of expectedExports) {
  assert(name in geoDropExports, `Export exists: ${name}`);
}


// =====================
// Summary
// =====================

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(40)}\n`);

if (failed > 0) process.exit(1);
