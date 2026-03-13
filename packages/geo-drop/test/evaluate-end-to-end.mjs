import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import * as snarkjs from 'snarkjs';

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const ITERATIONS = 10;

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

async function deriveKey(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encrypt(data, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv: iv.buffer },
    key,
    new TextEncoder().encode(data)
  );
  return {
    ciphertext: toBase64(new Uint8Array(encrypted)),
    iv: toBase64(iv),
    salt: toBase64(salt),
  };
}

async function decrypt(payload, password) {
  const salt = fromBase64(payload.salt);
  const iv = fromBase64(payload.iv);
  const ciphertext = fromBase64(payload.ciphertext);
  const key = await deriveKey(password, salt);
  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: iv.buffer },
    key,
    ciphertext.buffer
  );
  return new TextDecoder().decode(decrypted);
}

function deriveLocationKey(geohash, dropId, salt, serverSecret = 'local-dev-secret') {
  return `geodrop:${geohash}:${dropId}:${salt}:${serverSecret}`;
}

function validatePrototype(ps) {
  return (
    ps[0] === '1' &&
    ps[1] === '35681200' &&
    ps[2] === '139767100' &&
    ps[3] === '201601' &&
    ps[4] === '812275'
  );
}

function validateZairn(ps) {
  return (
    ps[0] === '1' &&
    ps[1] === '35681200' &&
    ps[2] === '139767100' &&
    ps[3] === '201601' &&
    ps[4] === '812275' &&
    ps[6] === '42'
  );
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function measureEndToEnd({ proofPath, publicSignalsPath, vkeyPath, validate }) {
  const proof = JSON.parse(await readFile(proofPath, 'utf8'));
  const publicSignals = JSON.parse(await readFile(publicSignalsPath, 'utf8'));
  const vkey = JSON.parse(await readFile(vkeyPath, 'utf8'));
  const locationKey = deriveLocationKey('xn77h3c', 'drop-1', 'salt');
  const payload = await encrypt('hello-zairn', locationKey);

  const runs = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = performance.now();
    const ok = validate(publicSignals) && await snarkjs.groth16.verify(vkey, publicSignals, proof);
    if (!ok) throw new Error('verification failed');
    const decrypted = await decrypt(payload, locationKey);
    if (decrypted !== 'hello-zairn') throw new Error('decrypt failed');
    runs.push(performance.now() - start);
  }
  return average(runs);
}

async function main() {
  const prototypeMs = await measureEndToEnd({
    proofPath: './circuits/build/proximity_proof.json',
    publicSignalsPath: './circuits/build/proximity_public.json',
    vkeyPath: './circuits/proximity_verification_key.json',
    validate: validatePrototype,
  });

  const zairnMs = await measureEndToEnd({
    proofPath: './circuits/build/zairn_zkp_proof.json',
    publicSignalsPath: './circuits/build/zairn_zkp_public.json',
    vkeyPath: './circuits/verification_key.json',
    validate: validateZairn,
  });

  console.log(JSON.stringify({
    prototypeEndToEndMs: prototypeMs,
    zairnEndToEndMs: zairnMs,
  }, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
