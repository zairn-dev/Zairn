import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const circuitsDir = path.join(packageRoot, 'circuits');

const iterations = Math.max(1, Number.parseInt(process.env.ZKP_BENCH_ITERS ?? '5', 10) || 5);
function validatePublicSignals(publicSignals, input) {
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

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatMs(value) {
  return `${value.toFixed(2)} ms`;
}

async function main() {
  const verificationKeyPath = path.join(circuitsDir, 'verification_key.json');
  const sampleInputPath = path.join(circuitsDir, 'example-zairn-zkp-input.json');
  const verificationKey = JSON.parse(await readFile(verificationKeyPath, 'utf8'));
  const input = JSON.parse(await readFile(sampleInputPath, 'utf8'));
  const wasmPath = path.join(circuitsDir, 'build', 'zairn_zkp_js', 'zairn_zkp.wasm');
  const zkeyPath = path.join(circuitsDir, 'zairn_zkp_final.zkey');

  const fullProveTimes = [];
  const verifyTimes = [];
  const signalCheckTimes = [];
  let proofSizeBytes = 0;
  let publicSignalCount = 0;
  let signalMismatchCount = 0;

  for (let i = 0; i < iterations; i += 1) {
    const proveStart = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);
    fullProveTimes.push(performance.now() - proveStart);

    const signalStart = performance.now();
    const signalsValid = validatePublicSignals(publicSignals, input);
    signalCheckTimes.push(performance.now() - signalStart);
    if (!signalsValid) signalMismatchCount += 1;

    const verifyStart = performance.now();
    const proofValid = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
    verifyTimes.push(performance.now() - verifyStart);
    if (!proofValid) {
      throw new Error(`proof verification failed at iteration ${i + 1}`);
    }

    proofSizeBytes = Buffer.byteLength(JSON.stringify(proof));
    publicSignalCount = publicSignals.length;
  }

  console.log('Zairn-ZKP benchmark');
  console.log(`Iterations: ${iterations}`);
  console.log(`Proof generation avg: ${formatMs(average(fullProveTimes))}`);
  console.log(`Proof verification avg: ${formatMs(average(verifyTimes))}`);
  console.log(`Public signal check avg: ${formatMs(average(signalCheckTimes))}`);
  console.log(`Proof JSON size: ${proofSizeBytes} bytes`);
  console.log(`Public signals: ${publicSignalCount}`);
  console.log(`Public signal mismatches: ${signalMismatchCount}/${iterations}`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
