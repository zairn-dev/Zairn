import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import * as snarkjs from 'snarkjs';

async function main() {
  const input = JSON.parse(await readFile('./circuits/example-proximity-input.json', 'utf8'));
  const vkey = JSON.parse(await readFile('./circuits/proximity_verification_key.json', 'utf8'));

  const proveStart = performance.now();
  const out = await snarkjs.groth16.fullProve(
    input,
    './circuits/build/proximity_js/proximity.wasm',
    './circuits/proximity_final.zkey'
  );
  const proveMs = performance.now() - proveStart;

  const verifyRuns = [];
  for (let i = 0; i < 10; i += 1) {
    const start = performance.now();
    await snarkjs.groth16.verify(vkey, out.publicSignals, out.proof);
    verifyRuns.push(performance.now() - start);
  }

  const verifyMs = verifyRuns.reduce((a, b) => a + b, 0) / verifyRuns.length;

  console.log(JSON.stringify({
    proveMs,
    verifyMs,
    proofSize: Buffer.byteLength(JSON.stringify(out.proof)),
    signalCount: out.publicSignals.length,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
