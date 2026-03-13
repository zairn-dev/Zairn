import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildZkStatementBinding,
  generateZairnZkpProof,
  validatePublicSignals,
  verifyProximityProof,
  type VerificationKey,
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const circuitsDir = path.join(packageRoot, 'circuits');

const iterations = Math.max(1, Number.parseInt(process.env.ZKP_BENCH_ITERS ?? '5', 10) || 5);
const targetLat = 35.6812;
const targetLon = 139.7671;
const unlockRadius = 50;
const userLat = 35.68125;
const userLon = 139.76715;

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatMs(value: number): string {
  return `${value.toFixed(2)} ms`;
}

async function main() {
  const verificationKeyPath = path.join(circuitsDir, 'verification_key.json');
  const verificationKey = JSON.parse(await readFile(verificationKeyPath, 'utf8')) as VerificationKey;

  const context = {
    dropId: 'bench-drop',
    policyVersion: '1',
    epoch: '2026-03-13T12',
    serverNonce: 'bench-nonce-001',
  };
  const expectedStatement = await buildZkStatementBinding(context);
  const config = {
    artifacts: {
      wasmUrl: path.join(circuitsDir, 'build', 'zairn_zkp_js', 'zairn_zkp.wasm'),
      zkeyUrl: path.join(circuitsDir, 'zairn_zkp_final.zkey'),
    },
  };

  const fullProveTimes: number[] = [];
  const verifyTimes: number[] = [];
  const publicSignalTimes: number[] = [];
  let proofSizeBytes = 0;
  let publicSignalCount = 0;

  for (let i = 0; i < iterations; i += 1) {
    const proveStart = performance.now();
    const { proof, publicSignals, statement } = await generateZairnZkpProof(
      userLat,
      userLon,
      targetLat,
      targetLon,
      unlockRadius,
      context,
      config
    );
    fullProveTimes.push(performance.now() - proveStart);

    const signalStart = performance.now();
    const signalsValid = validatePublicSignals(publicSignals, targetLat, targetLon, unlockRadius, statement);
    publicSignalTimes.push(performance.now() - signalStart);
    if (!signalsValid) {
      throw new Error(`public signal validation failed at iteration ${i + 1}`);
    }
    if (statement.contextDigest !== expectedStatement.contextDigest) {
      throw new Error('statement binding drift detected');
    }

    const verifyStart = performance.now();
    const proofValid = await verifyProximityProof(proof, publicSignals, verificationKey);
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
  console.log(`Public signal check avg: ${formatMs(average(publicSignalTimes))}`);
  console.log(`Proof JSON size: ${proofSizeBytes} bytes`);
  console.log(`Public signals: ${publicSignalCount}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
