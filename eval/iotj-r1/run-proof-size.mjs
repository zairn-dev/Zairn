// Size and Node-side cost of one step-up proof (reviewer comments R1-6, R3-4).
//
// Generates N proofs for the zairn_zkp circuit used by the step-up prototype
// (same artifacts, same input encoding as stepup-proto/smoke-test.mjs) at an
// arbitrary point in open sea, and reports
//   - proof size: snarkjs JSON, and the BN254 encodings (2 G1 + 1 G2 points:
//     256 B uncompressed, 128 B compressed);
//   - public signals: count and JSON size; the request body sent to /api/verify;
//   - prove / verify time in Node and the process RSS (MB) after proving.
//
// Usage: node eval/iotj-r1/run-proof-size.mjs [N=20]
// Writes results/proof-size.json.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import {
  buildZkStatementBinding, lengthPrefixEncode, toFixedPoint, metersToRadiusSquared, cosLatScaled,
} from '../../packages/geo-drop/dist/zkp.js';

const here = dirname(fileURLToPath(import.meta.url));
const snarkjs = createRequire(join(here, '../../packages/geo-drop/package.json'))('snarkjs');
const art = join(here, 'stepup-proto', 'artifacts');
const N = Number(process.argv[2] ?? 20);
const CENTER = { lat: 10.0, lon: 150.0 };
const RADIUS_M = 50;
const vkey = JSON.parse(readFileSync(join(art, 'zairn_zkp_vkey.json'), 'utf8'));

const quantile = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };
const r1 = (x) => Math.round(x * 10) / 10;

const prove = [], verify = [];
let proofJsonBytes, signalsJsonBytes, nSignals, bodyBytes, rssMb = 0;
for (let i = 0; i < N + 1; i++) {
  const token = `ZT1.venue.${1000 + i}.AAAAAAAAAAAAAAAAAAAAAA`;
  const statement = await buildZkStatementBinding({
    dropId: 'venue', policyVersion: '1', epoch: 1000 + i,
    serverNonce: lengthPrefixEncode(`nonce-${i}`, token),
  });
  const input = {
    targetLat: toFixedPoint(CENTER.lat).toString(), targetLon: toFixedPoint(CENTER.lon).toString(),
    radiusSquared: metersToRadiusSquared(RADIUS_M).toString(), cosLatScaled: cosLatScaled(CENTER.lat).toString(),
    contextDigest: statement.contextDigest, epoch: statement.epoch, challengeDigest: statement.challengeDigest,
    userLat: toFixedPoint(CENTER.lat + 0.0001).toString(), userLon: toFixedPoint(CENTER.lon).toString(),
  };
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, join(art, 'zairn_zkp_js/zairn_zkp.wasm'), join(art, 'zairn_zkp_final.zkey'));
  const t1 = performance.now();
  const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  const t2 = performance.now();
  if (!ok) throw new Error('proof did not verify');
  rssMb = Math.max(rssMb, process.memoryUsage().rss / 2 ** 20);
  if (i === 0) continue; // first run: wasm compile and curve set-up
  prove.push(t1 - t0); verify.push(t2 - t1);
  proofJsonBytes = Buffer.byteLength(JSON.stringify(proof));
  signalsJsonBytes = Buffer.byteLength(JSON.stringify(publicSignals));
  nSignals = publicSignals.length;
  bodyBytes = Buffer.byteLength(JSON.stringify({ sessionId: '00000000-0000-0000-0000-000000000000', token, proof, publicSignals }));
}
await snarkjs.curves?.terminate?.();
globalThis.curve_bn128?.terminate?.();

const out = {
  generated: new Date().toISOString(), n: N, node: process.version,
  proof: { jsonBytes: proofJsonBytes, bn254UncompressedBytes: 256, bn254CompressedBytes: 128 },
  publicSignals: { count: nSignals, jsonBytes: signalsJsonBytes, rawBytes: nSignals * 32 },
  verifyRequestBodyBytes: bodyBytes,
  nodeProveMs: { p50: r1(quantile(prove, 0.5)), p95: r1(quantile(prove, 0.95)) },
  nodeVerifyMs: { p50: r1(quantile(verify, 0.5)), p95: r1(quantile(verify, 0.95)) },
  peakRssMb: r1(rssMb),
};
mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'proof-size.json'), JSON.stringify(out, null, 2));
console.error(JSON.stringify(out, null, 2));
process.exit(0);
