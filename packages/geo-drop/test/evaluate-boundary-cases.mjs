import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as snarkjs from 'snarkjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const circuitsDir = path.join(packageRoot, 'circuits');
const SCALE = 1_000_000;
const METERS_PER_DEG_LAT = 111_320;
const DEG2RAD = Math.PI / 180;

function toFixedPoint(degrees) {
  return BigInt(Math.round(degrees * SCALE)).toString();
}

function metersToRadiusSquared(meters) {
  const rDeg = meters / METERS_PER_DEG_LAT;
  const rFp = BigInt(Math.round(rDeg * SCALE));
  return (rFp * rFp).toString();
}

function cosLatScaled(latDegrees) {
  return BigInt(Math.round(Math.cos(latDegrees * DEG2RAD) * SCALE)).toString();
}

function hashToDecimal(value) {
  const digest = createHash('sha256').update(value).digest('hex');
  return BigInt(`0x${digest}`).toString();
}

function metersNorth(baseLat, meters) {
  return baseLat + (meters / METERS_PER_DEG_LAT);
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function runCase({ label, input, wasmPath, zkeyPath, verificationKey }) {
  const startedAt = performance.now();
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
    const proveMs = performance.now() - startedAt;
    const verifyStartedAt = performance.now();
    const verified = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
    const verifyMs = performance.now() - verifyStartedAt;
    return {
      label,
      accepted: verified,
      proveMs: Number(proveMs.toFixed(4)),
      verifyMs: Number(verifyMs.toFixed(4)),
      signalCount: publicSignals.length,
    };
  } catch (error) {
    return {
      label,
      accepted: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const targetLat = 35.6812;
  const targetLon = 139.7671;
  const radiusMeters = 50;

  const prototypeVKey = await loadJson(path.join(circuitsDir, 'proximity_verification_key.json'));
  const zairnVKey = await loadJson(path.join(circuitsDir, 'verification_key.json'));

  const prototypeBase = {
    targetLat: toFixedPoint(targetLat),
    targetLon: toFixedPoint(targetLon),
    radiusSquared: metersToRadiusSquared(radiusMeters),
    cosLatScaled: cosLatScaled(targetLat),
  };

  const zairnBase = {
    ...prototypeBase,
    contextDigest: hashToDecimal('bench-drop:1:42'),
    epoch: '42',
    challengeDigest: hashToDecimal('boundary-check'),
  };

  const cases = [
    {
      label: 'prototype_inside_45m',
      input: {
        ...prototypeBase,
        userLat: toFixedPoint(metersNorth(targetLat, 45)),
        userLon: toFixedPoint(targetLon),
      },
      wasmPath: path.join(circuitsDir, 'build', 'proximity_js', 'proximity.wasm'),
      zkeyPath: path.join(circuitsDir, 'proximity_final.zkey'),
      verificationKey: prototypeVKey,
    },
    {
      label: 'prototype_outside_55m',
      input: {
        ...prototypeBase,
        userLat: toFixedPoint(metersNorth(targetLat, 55)),
        userLon: toFixedPoint(targetLon),
      },
      wasmPath: path.join(circuitsDir, 'build', 'proximity_js', 'proximity.wasm'),
      zkeyPath: path.join(circuitsDir, 'proximity_final.zkey'),
      verificationKey: prototypeVKey,
    },
    {
      label: 'zairn_inside_45m',
      input: {
        ...zairnBase,
        userLat: toFixedPoint(metersNorth(targetLat, 45)),
        userLon: toFixedPoint(targetLon),
      },
      wasmPath: path.join(circuitsDir, 'build', 'zairn_zkp_js', 'zairn_zkp.wasm'),
      zkeyPath: path.join(circuitsDir, 'zairn_zkp_final.zkey'),
      verificationKey: zairnVKey,
    },
    {
      label: 'zairn_outside_55m',
      input: {
        ...zairnBase,
        userLat: toFixedPoint(metersNorth(targetLat, 55)),
        userLon: toFixedPoint(targetLon),
      },
      wasmPath: path.join(circuitsDir, 'build', 'zairn_zkp_js', 'zairn_zkp.wasm'),
      zkeyPath: path.join(circuitsDir, 'zairn_zkp_final.zkey'),
      verificationKey: zairnVKey,
    },
  ];

  const results = [];
  for (const testCase of cases) {
    results.push(await runCase(testCase));
  }

  console.log(JSON.stringify({
    targetLat,
    targetLon,
    radiusMeters,
    cases: results,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
