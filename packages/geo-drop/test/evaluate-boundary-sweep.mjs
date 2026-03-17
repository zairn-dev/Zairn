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

async function tryFullProve(input, wasmPath, zkeyPath, verificationKey) {
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
    const accepted = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
    return { accepted, signalCount: publicSignals.length };
  } catch (error) {
    return { accepted: false, error: error instanceof Error ? error.message.trim() : String(error) };
  }
}

async function main() {
  const targetLat = 35.6812;
  const targetLon = 139.7671;
  const radiusMeters = 50;
  const distances = [45, 49, 50, 51, 55];

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
    challengeDigest: hashToDecimal('boundary-sweep'),
  };

  const prototypeCases = [];
  const zairnCases = [];

  for (const distanceMeters of distances) {
    prototypeCases.push({
      distanceMeters,
      ...(await tryFullProve(
        {
          ...prototypeBase,
          userLat: toFixedPoint(metersNorth(targetLat, distanceMeters)),
          userLon: toFixedPoint(targetLon),
        },
        path.join(circuitsDir, 'build', 'proximity_js', 'proximity.wasm'),
        path.join(circuitsDir, 'proximity_final.zkey'),
        prototypeVKey
      )),
    });

    zairnCases.push({
      distanceMeters,
      ...(await tryFullProve(
        {
          ...zairnBase,
          userLat: toFixedPoint(metersNorth(targetLat, distanceMeters)),
          userLon: toFixedPoint(targetLon),
        },
        path.join(circuitsDir, 'build', 'zairn_zkp_js', 'zairn_zkp.wasm'),
        path.join(circuitsDir, 'zairn_zkp_final.zkey'),
        zairnVKey
      )),
    });
  }

  console.log(JSON.stringify({
    targetLat,
    targetLon,
    radiusMeters,
    prototypeCases,
    zairnCases,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
