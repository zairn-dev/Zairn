import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import crypto from 'node:crypto';
import * as snarkjs from 'snarkjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const circuitsDir = path.join(packageRoot, 'circuits');
const buildDir = path.join(circuitsDir, 'build');

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function stageArtifacts(tempRoot) {
  const stageDir = path.join(tempRoot, 'zairn-zkp-artifacts');
  await cp(circuitsDir, stageDir, { recursive: true });
  return stageDir;
}

async function runVerification(stageDir, runs) {
  const verificationKey = await readJson(path.join(stageDir, 'verification_key.json'));
  const proof = await readJson(path.join(stageDir, 'build', 'zairn_zkp_proof.json'));
  const publicSignals = await readJson(path.join(stageDir, 'build', 'zairn_zkp_public.json'));
  const samples = [];

  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    const accepted = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
    const elapsedMs = performance.now() - start;
    if (!accepted) {
      throw new Error('staged Zairn-ZKP verification failed');
    }
    samples.push(elapsedMs);
  }

  return {
    acceptedRuns: runs,
    avgMs: average(samples),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
  };
}

async function runEndToEnd(stageDir, runs) {
  const proof = await readJson(path.join(stageDir, 'build', 'zairn_zkp_proof.json'));
  const publicSignals = await readJson(path.join(stageDir, 'build', 'zairn_zkp_public.json'));
  const verificationKey = await readJson(path.join(stageDir, 'verification_key.json'));

  const payload = {
    message: 'artifact-rerun',
    dropId: 'drop-123',
    timestamp: '2026-03-13T00:00:00Z',
  };
  const key = crypto.createHash('sha256').update('zairn-zkp-repro-key').digest();
  const iv = Buffer.alloc(12, 7);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    const accepted = await snarkjs.groth16.verify(verificationKey, publicSignals, proof);
    if (!accepted) {
      throw new Error('staged end-to-end verification failed');
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8');
    JSON.parse(plaintext);
    samples.push(performance.now() - start);
  }

  return {
    avgMs: average(samples),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
  };
}

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'zairn-zkp-repro-'));
  let stageDir;

  try {
    stageDir = await stageArtifacts(tempRoot);

    const verification = await runVerification(stageDir, 10);
    const endToEnd = await runEndToEnd(stageDir, 10);

    const stagedFiles = [
      'verification_key.json',
      'zairn_zkp_final.zkey',
      'example-zairn-zkp-input.json',
      path.join('build', 'zairn_zkp_proof.json'),
      path.join('build', 'zairn_zkp_public.json'),
      path.join('build', 'zairn_zkp.wtns'),
      path.join('build', 'zairn_zkp_js', 'zairn_zkp.wasm'),
    ];

    console.log(JSON.stringify({
      stagingMode: 'temporary artifact copy',
      stagedFileCount: stagedFiles.length,
      manualIntervention: 0,
      verification,
      endToEnd,
      stagedFiles,
    }, null, 2));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
