import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import * as snarkjs from 'snarkjs';

function validate(ps) {
  return (
    ps[0] === '1' &&
    ps[1] === '35681200' &&
    ps[2] === '139767100' &&
    ps[3] === '201601' &&
    ps[4] === '812275'
  );
}

async function main() {
  const proof = JSON.parse(await readFile('./circuits/build/proximity_proof.json', 'utf8'));
  const publicSignals = JSON.parse(await readFile('./circuits/build/proximity_public.json', 'utf8'));
  const vkey = JSON.parse(await readFile('./circuits/proximity_verification_key.json', 'utf8'));

  const runs = [];
  for (let i = 0; i < 10; i += 1) {
    const start = performance.now();
    const ok = validate(publicSignals) && await snarkjs.groth16.verify(vkey, publicSignals, proof);
    runs.push(performance.now() - start);
    if (!ok) throw new Error('prototype verify failed');
  }

  const unlockLatencyMs = runs.reduce((a, b) => a + b, 0) / runs.length;
  console.log(JSON.stringify({ unlockLatencyMs }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
