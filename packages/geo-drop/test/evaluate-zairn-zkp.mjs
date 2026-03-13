import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const circuitsDir = path.join(packageRoot, 'circuits');
const buildDir = path.join(circuitsDir, 'build');

function hashToDecimal(value) {
  const digest = createHash('sha256').update(value).digest('hex');
  return BigInt(`0x${digest}`).toString();
}

function buildStatement({ dropId, policyVersion = '1', epoch, serverNonce }) {
  return {
    contextDigest: hashToDecimal(`${dropId}:${policyVersion}:${epoch}`),
    epoch: String(epoch),
    challengeDigest: hashToDecimal(serverNonce),
  };
}

function expectedSignalsFromInput(input) {
  return [
    '1',
    input.targetLat,
    input.targetLon,
    input.radiusSquared,
    input.cosLatScaled,
    input.contextDigest,
    input.epoch,
    input.challengeDigest,
  ];
}

function validateWithStatement(publicSignals, input, statement) {
  const expected = [
    '1',
    input.targetLat,
    input.targetLon,
    input.radiusSquared,
    input.cosLatScaled,
    statement.contextDigest,
    statement.epoch,
    statement.challengeDigest,
  ];
  return expected.every((value, index) => publicSignals[index] === value);
}

function validatePrototypeStyle(publicSignals, input) {
  const expected = expectedSignalsFromInput(input).slice(0, 5);
  return expected.every((value, index) => publicSignals[index] === value);
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

function verifyGps({ targetLat, targetLon, unlockRadius, userLat, userLon, accuracy }) {
  const distance = calculateDistance(targetLat, targetLon, userLat, userLon);
  const maxAccuracy = Math.min(50, unlockRadius / 2);
  const effectiveAccuracy = Math.min(accuracy, maxAccuracy);
  return (distance - effectiveAccuracy) <= unlockRadius;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function main() {
  const verificationKey = JSON.parse(await readFile(path.join(circuitsDir, 'verification_key.json'), 'utf8'));
  const input = JSON.parse(await readFile(path.join(circuitsDir, 'example-zairn-zkp-input.json'), 'utf8'));
  const proof = JSON.parse(await readFile(path.join(buildDir, 'zairn_zkp_proof.json'), 'utf8'));
  const publicSignals = JSON.parse(await readFile(path.join(buildDir, 'zairn_zkp_public.json'), 'utf8'));

  const currentStatement = {
    contextDigest: input.contextDigest,
    epoch: input.epoch,
    challengeDigest: input.challengeDigest,
  };
  const replayStatement = buildStatement({
    dropId: 'other-drop',
    policyVersion: '1',
    epoch: input.epoch,
    serverNonce: 'zairn-zkp-replay',
  });
  const staleStatement = buildStatement({
    dropId: 'bench-drop',
    policyVersion: '1',
    epoch: '41',
    serverNonce: 'zairn-zkp-stale',
  });

  const validProof = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);

  const replayPrototypeAccepted = validatePrototypeStyle(publicSignals, input);
  const replayContextAccepted = validateWithStatement(publicSignals, input, replayStatement);
  const stalePrototypeAccepted = validatePrototypeStyle(publicSignals, input);
  const staleContextAccepted = validateWithStatement(publicSignals, input, staleStatement);

  const tamperedSignals = [...publicSignals];
  tamperedSignals[5] = replayStatement.contextDigest;
  const tamperedProofAccepted = await snarkjs.groth16.verify(verificationKey, tamperedSignals, proof);

  const zkpVerifyTimes = [];
  for (let i = 0; i < 10; i += 1) {
    const start = performance.now();
    await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
    zkpVerifyTimes.push(performance.now() - start);
  }

  const gpsVerifyTimes = [];
  for (let i = 0; i < 1000; i += 1) {
    const start = performance.now();
    verifyGps({
      targetLat: 35.6812,
      targetLon: 139.7671,
      unlockRadius: 50,
      userLat: 35.68125,
      userLon: 139.76715,
      accuracy: 10,
    });
    gpsVerifyTimes.push(performance.now() - start);
  }

  console.log('Zairn-ZKP evaluation snapshot');
  console.log(`Valid proof verification: ${validProof ? 'accepted' : 'rejected'}`);
  console.log(`Cross-drop replay (prototype-style check): ${replayPrototypeAccepted ? 'accepted' : 'rejected'}`);
  console.log(`Cross-drop replay (context-bound check): ${replayContextAccepted ? 'accepted' : 'rejected'}`);
  console.log(`Stale context (prototype-style check): ${stalePrototypeAccepted ? 'accepted' : 'rejected'}`);
  console.log(`Stale context (context-bound check): ${staleContextAccepted ? 'accepted' : 'rejected'}`);
  console.log(`Malformed public signals (cryptographic verify): ${tamperedProofAccepted ? 'accepted' : 'rejected'}`);
  console.log(`GPS verification avg over 1000 runs: ${average(gpsVerifyTimes).toFixed(4)} ms`);
  console.log(`ZKP verification avg over 10 runs: ${average(zkpVerifyTimes).toFixed(2)} ms`);
  console.log(`Signal count: ${publicSignals.length}`);
  console.log(`Context-bound baseline match: ${validateWithStatement(publicSignals, input, currentStatement) ? 'accepted' : 'rejected'}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
