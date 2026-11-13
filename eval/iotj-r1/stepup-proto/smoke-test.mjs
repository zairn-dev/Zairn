// End-to-end check of server.mjs without a phone: starts the server, plays the
// venue display and the phone in Node, and checks accept / reject paths.
//
// Usage: node eval/iotj-r1/stepup-proto/smoke-test.mjs

import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  buildZkStatementBinding, lengthPrefixEncode, toFixedPoint, metersToRadiusSquared, cosLatScaled,
} from '../../../packages/geo-drop/dist/zkp.js';

const here = dirname(fileURLToPath(import.meta.url));
const snarkjs = createRequire(join(here, '../../../packages/geo-drop/package.json'))('snarkjs');
const PORT = 18787;
const base = `http://localhost:${PORT}`;
const LIFETIME = 30;
// Arbitrary test point (not a real venue): open sea.
const CENTER = { lat: 10.0, lon: 150.0 };

const server = spawn(process.execPath, [join(here, 'server.mjs'), '--port', String(PORT), '--lifetime', String(LIFETIME), '--venue', 'smoke', '--log', 'smoke'], { stdio: ['ignore', 'pipe', 'inherit'] });
const adminKey = await new Promise((resolve, reject) => {
  let out = '';
  server.stdout.on('data', (d) => {
    out += d;
    const m = /admin key for calibration:\s+([0-9a-f]+)/.exec(out);
    if (m) resolve(m[1]);
  });
  server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
});

const post = async (path, body) => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let failures = 0;
const expect = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!cond) failures++;
};

try {
  const { key, venueId } = await (await fetch(`${base}/api/venue-key`)).json();
  const tokenFor = (slot) => {
    const msg = `ZT1.${venueId}.${slot}`;
    return `${msg}.${b64url(createHmac('sha256', Buffer.from(key, 'base64url')).update(msg).digest()).slice(0, 22)}`;
  };
  const slotNow = () => Math.floor(Date.now() / 1000 / LIFETIME);

  expect('calibrate rejects a wrong admin key', (await post('/api/calibrate', { adminKey: 'x', ...CENTER })).error === 'bad admin key');
  expect('calibrate', (await post('/api/calibrate', { adminKey, ...CENTER })).ok === true);

  async function attempt({ token, user = { lat: CENTER.lat + 0.0001, lon: CENTER.lon }, tamper }) {
    const s = await post('/api/session', { device: 'node', trialType: 'smoke' });
    const slot = Number(token.split('.')[2]);
    const statement = await buildZkStatementBinding({
      dropId: s.venueId, policyVersion: s.policyVersion, epoch: slot,
      serverNonce: lengthPrefixEncode(tamper === 'otherNonce' ? 'not-the-nonce' : s.nonce, token),
    });
    const input = {
      targetLat: toFixedPoint(s.center.lat).toString(), targetLon: toFixedPoint(s.center.lon).toString(),
      radiusSquared: metersToRadiusSquared(s.radiusM).toString(), cosLatScaled: cosLatScaled(s.center.lat).toString(),
      contextDigest: statement.contextDigest, epoch: statement.epoch, challengeDigest: statement.challengeDigest,
      userLat: toFixedPoint(user.lat).toString(), userLon: toFixedPoint(user.lon).toString(),
    };
    let proof, publicSignals;
    try {
      ({ proof, publicSignals } = await snarkjs.groth16.fullProve(input,
        join(here, 'artifacts/zairn_zkp_js/zairn_zkp.wasm'), join(here, 'artifacts/zairn_zkp_final.zkey')));
    } catch {
      return post('/api/verify', { sessionId: s.sessionId, clientError: 'out_of_radius_or_prove_failed' });
    }
    if (tamper === 'proof') proof.pi_a[0] = (BigInt(proof.pi_a[0]) + 1n).toString();
    const r = await post('/api/verify', { sessionId: s.sessionId, token, proof, publicSignals });
    if (tamper === 'replay') return post('/api/verify', { sessionId: s.sessionId, token, proof, publicSignals });
    return r;
  }

  const fresh = tokenFor(slotNow());
  const r1 = await attempt({ token: fresh });
  expect('fresh token, inside radius -> accepted', r1.ok === true, r1);
  expect('previous slot still accepted (grace)', (await attempt({ token: tokenFor(slotNow() - 1) })).ok === true);
  expect('two slots old -> token_expired', (await attempt({ token: tokenFor(slotNow() - 2) })).reason === 'token_expired');
  expect('forged MAC -> token_bad_mac', (await attempt({ token: `ZT1.${venueId}.${slotNow()}.AAAAAAAAAAAAAAAAAAAAAA` })).reason === 'token_bad_mac');
  expect('no token -> token_bad_mac', (await attempt({ token: `ZT1.${venueId}.0.AAAAAAAAAAAAAAAAAAAAAA` })).ok === false);
  expect('challenge bound to another nonce -> mismatch', (await attempt({ token: fresh, tamper: 'otherNonce' })).reason === 'public_signals_mismatch');
  expect('tampered proof -> proof_invalid', (await attempt({ token: fresh, tamper: 'proof' })).reason === 'proof_invalid');
  expect('session reuse -> session_reused', (await attempt({ token: fresh, tamper: 'replay' })).reason === 'session_reused');
  expect('500 m away -> client failure logged', (await attempt({ token: fresh, user: { lat: CENTER.lat + 0.0045, lon: CENTER.lon } })).reason === 'client_out_of_radius_or_prove_failed');

  const tunneled = await fetch(`${base}/api/venue-key`, { headers: { 'cf-connecting-ip': '203.0.113.7' } });
  expect('venue key refused through a tunnel', tunneled.status === 403);
} finally {
  server.kill();
}
console.log(failures ? `${failures} failure(s)` : 'all passed');
process.exit(failures ? 1 : 0);
