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

const PROVE_RUNS = Math.max(1, Number.parseInt(process.env.ZKP_PAPER_PROVE_RUNS ?? '3', 10) || 3);
const VERIFY_RUNS = Math.max(1, Number.parseInt(process.env.ZKP_PAPER_VERIFY_RUNS ?? '30', 10) || 30);
const GPS_RUNS = Math.max(1, Number.parseInt(process.env.ZKP_PAPER_GPS_RUNS ?? '1000', 10) || 1000);

function hashToDecimal(value) {
  const digest = createHash('sha256').update(value).digest('hex');
  return BigInt(`0x${digest}`).toString();
}

function lengthPrefixEncode(...fields) {
  return fields.map(f => `${String(f).length.toString(10).padStart(4, '0')}${f}`).join('');
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function stddev(values) {
  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function summarize(values) {
  return {
    runs: values.length,
    avgMs: Number(average(values).toFixed(4)),
    medianMs: Number(median(values).toFixed(4)),
    minMs: Number(Math.min(...values).toFixed(4)),
    maxMs: Number(Math.max(...values).toFixed(4)),
    stddevMs: Number(stddev(values).toFixed(4)),
  };
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

function validatePrototypeSignals(publicSignals, input) {
  const expected = [
    '1',
    input.targetLat,
    input.targetLon,
    input.radiusSquared,
    input.cosLatScaled,
  ];
  return expected.every((value, index) => publicSignals[index] === value);
}

function validateZairnSignals(publicSignals, input) {
  const expected = [
    '1',
    input.targetLat,
    input.targetLon,
    input.radiusSquared,
    input.cosLatScaled,
    input.contextDigest,
    input.epoch,
    input.challengeDigest,
  ];
  return expected.every((value, index) => publicSignals[index] === value);
}

function validateExpectedSignals(publicSignals, expected) {
  return expected.every((value, index) => publicSignals[index] === value);
}

function validateZairnSignalsWithStatement(publicSignals, input, statement) {
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

function buildStatement({ dropId, policyVersion = '1', epoch, serverNonce }) {
  return {
    contextDigest: hashToDecimal(lengthPrefixEncode(dropId, policyVersion, String(epoch))),
    epoch: String(epoch),
    challengeDigest: hashToDecimal(serverNonce),
  };
}

async function loadJson(...parts) {
  return JSON.parse(await readFile(path.join(...parts), 'utf8'));
}

async function measureProve({ input, wasmPath, zkeyPath, verificationKey, signalValidator, runs }) {
  const proveTimes = [];
  const verifyTimes = [];
  let proofSizeBytes = 0;
  let signalCount = 0;
  let signalMismatchCount = 0;

  for (let i = 0; i < runs; i += 1) {
    const proveStart = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
    proveTimes.push(performance.now() - proveStart);

    if (!signalValidator(publicSignals, input)) {
      signalMismatchCount += 1;
    }

    const verifyStart = performance.now();
    const verified = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
    verifyTimes.push(performance.now() - verifyStart);
    if (!verified) {
      throw new Error(`proof verification failed at iteration ${i + 1}`);
    }

    proofSizeBytes = Buffer.byteLength(JSON.stringify(proof));
    signalCount = publicSignals.length;
  }

  return {
    prove: summarize(proveTimes),
    verifyDuringProve: summarize(verifyTimes),
    proofSizeBytes,
    signalCount,
    signalMismatchCount,
  };
}

async function measureVerifyOnly({ verificationKey, proof, publicSignals, runs }) {
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    const verified = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
    times.push(performance.now() - start);
    if (!verified) {
      throw new Error(`verify-only run failed at iteration ${i + 1}`);
    }
  }
  return summarize(times);
}

async function measureUnlockPath({ verificationKey, proof, publicSignals, verifyFn, runs }) {
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    const accepted = await verifyFn({ verificationKey, proof, publicSignals });
    times.push(performance.now() - start);
    if (!accepted) {
      throw new Error(`unlock-path run failed at iteration ${i + 1}`);
    }
  }
  return summarize(times);
}

async function measureGpsBaseline(runs) {
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    const accepted = verifyGps({
      targetLat: 35.6812,
      targetLon: 139.7671,
      unlockRadius: 50,
      userLat: 35.68125,
      userLon: 139.76715,
      accuracy: 10,
    });
    times.push(performance.now() - start);
    if (!accepted) {
      throw new Error('GPS baseline unexpectedly failed');
    }
  }
  return summarize(times);
}

async function main() {
  const environment = {
    os: process.platform,
    node: process.version,
    proveRuns: PROVE_RUNS,
    verifyRuns: VERIFY_RUNS,
    gpsRuns: GPS_RUNS,
  };

  const prototypeInput = await loadJson(circuitsDir, 'example-proximity-input.json');
  const prototypeVKey = await loadJson(circuitsDir, 'proximity_verification_key.json');
  const prototypeProof = await loadJson(buildDir, 'proximity_proof.json');
  const prototypePublicSignals = await loadJson(buildDir, 'proximity_public.json');

  const zairnInput = await loadJson(circuitsDir, 'example-zairn-zkp-input.json');
  const zairnVKey = await loadJson(circuitsDir, 'verification_key.json');
  const zairnProof = await loadJson(buildDir, 'zairn_zkp_proof.json');
  const zairnPublicSignals = await loadJson(buildDir, 'zairn_zkp_public.json');

  const replayStatement = buildStatement({
    dropId: 'other-drop',
    epoch: zairnPublicSignals[6],
    serverNonce: 'zairn-zkp-replay',
  });
  const staleStatement = buildStatement({
    dropId: 'bench-drop',
    epoch: '41',
    serverNonce: 'zairn-zkp-stale',
  });
  const zairnExpectedSignals = [...zairnPublicSignals];

  const security = {
    validProofAccepted: await snarkjs.groth16.verify(zairnVKey, zairnPublicSignals, zairnProof),
    prototypeReplayAccepted: validatePrototypeSignals(prototypePublicSignals, prototypeInput),
    zairnReplayAccepted: validateExpectedSignals(zairnPublicSignals, [
      ...zairnExpectedSignals.slice(0, 5),
      replayStatement.contextDigest,
      zairnExpectedSignals[6],
      zairnExpectedSignals[7],
    ]),
    prototypeStaleAccepted: validatePrototypeSignals(prototypePublicSignals, prototypeInput),
    zairnStaleAccepted: validateExpectedSignals(zairnPublicSignals, [
      ...zairnExpectedSignals.slice(0, 5),
      zairnExpectedSignals[5],
      staleStatement.epoch,
      zairnExpectedSignals[7],
    ]),
    tamperedZairnSignalsAccepted: await snarkjs.groth16.verify(
      zairnVKey,
      [...zairnExpectedSignals.slice(0, 5), replayStatement.contextDigest, zairnExpectedSignals[6], zairnExpectedSignals[7]],
      zairnProof
    ),
    gpsBoundaryInsideAccepted: verifyGps({
      targetLat: 35.6812,
      targetLon: 139.7671,
      unlockRadius: 50,
      userLat: 35.681649,
      userLon: 139.7671,
      accuracy: 0,
    }),
    gpsBoundaryOutsideAccepted: verifyGps({
      targetLat: 35.6812,
      targetLon: 139.7671,
      unlockRadius: 50,
      userLat: 35.681651,
      userLon: 139.7671,
      accuracy: 0,
    }),
  };

  const prototype = {
    proofSizeBytes: Buffer.byteLength(JSON.stringify(prototypeProof)),
    signalCount: prototypePublicSignals.length,
  };
  try {
    Object.assign(prototype, await measureProve({
      input: prototypeInput,
      wasmPath: path.join(circuitsDir, 'build', 'proximity_js', 'proximity.wasm'),
      zkeyPath: path.join(circuitsDir, 'proximity_final.zkey'),
      verificationKey: prototypeVKey,
      signalValidator: validatePrototypeSignals,
      runs: PROVE_RUNS,
    }));
  } catch (error) {
    prototype.proveError = error instanceof Error ? error.message : String(error);
  }

  const zairn = {
    proofSizeBytes: Buffer.byteLength(JSON.stringify(zairnProof)),
    signalCount: zairnPublicSignals.length,
  };
  try {
    Object.assign(zairn, await measureProve({
      input: zairnInput,
      wasmPath: path.join(circuitsDir, 'build', 'zairn_zkp_js', 'zairn_zkp.wasm'),
      zkeyPath: path.join(circuitsDir, 'zairn_zkp_final.zkey'),
      verificationKey: zairnVKey,
      signalValidator: validateZairnSignals,
      runs: PROVE_RUNS,
    }));
  } catch (error) {
    zairn.proveError = error instanceof Error ? error.message : String(error);
  }

  prototype.verifyOnly = await measureVerifyOnly({
    verificationKey: prototypeVKey,
    proof: prototypeProof,
    publicSignals: prototypePublicSignals,
    runs: VERIFY_RUNS,
  });
  zairn.verifyOnly = await measureVerifyOnly({
    verificationKey: zairnVKey,
    proof: zairnProof,
    publicSignals: zairnPublicSignals,
    runs: VERIFY_RUNS,
  });

  prototype.unlockPath = await measureUnlockPath({
    verificationKey: prototypeVKey,
    proof: prototypeProof,
    publicSignals: prototypePublicSignals,
    runs: VERIFY_RUNS,
    verifyFn: async ({ verificationKey, proof, publicSignals }) => {
      if (!validatePrototypeSignals(publicSignals, prototypeInput)) return false;
      return snarkjs.groth16.verify(verificationKey, publicSignals, proof);
    },
  });
  zairn.unlockPath = await measureUnlockPath({
    verificationKey: zairnVKey,
    proof: zairnProof,
    publicSignals: zairnPublicSignals,
    runs: VERIFY_RUNS,
    verifyFn: async ({ verificationKey, proof, publicSignals }) => {
      if (!validateExpectedSignals(publicSignals, zairnExpectedSignals)) return false;
      return snarkjs.groth16.verify(verificationKey, publicSignals, proof);
    },
  });

  const gps = {
    verifyOnly: await measureGpsBaseline(GPS_RUNS),
  };

  console.log(JSON.stringify({
    environment,
    security,
    gps,
    prototype,
    zairn,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
