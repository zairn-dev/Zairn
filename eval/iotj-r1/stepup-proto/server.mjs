// Step-up prototype for the IoT-J revision: an on-site presence token bound
// into a Zairn-ZKP proximity proof.
//
// The venue display (venue.html) shows a QR code that changes every L
// seconds: ZT1.<venueId>.<slot>.<mac>, mac = HMAC-SHA256(venueKey, ...).
// The phone (index.html) gets a server nonce, scans the QR, takes one GPS
// fix, and proves "within R metres of the venue" with the challenge digest
// bound to (nonce, token). The server accepts iff the MAC is valid, the
// token is at most one slot old, the public signals match the venue and the
// binding, and the Groth16 proof verifies.
//
// Privacy: the venue centre is set at run time (calibrate button) and kept in
// memory only. The trial log holds outcomes and timings, never coordinates.
//
// Usage: node eval/iotj-r1/stepup-proto/server.mjs [--port 8787] [--lifetime 30] [--radius 50] [--venue id] [--log name]
// Then expose it over HTTPS, e.g.  cloudflared tunnel --url http://localhost:8787

import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  buildZkStatementBinding,
  lengthPrefixEncode,
  validatePublicSignals,
} from '../../../packages/geo-drop/dist/zkp.js';

const here = dirname(fileURLToPath(import.meta.url));
const geoDrop = join(here, '../../../packages/geo-drop');
const snarkjs = createRequire(join(geoDrop, 'package.json'))('snarkjs');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg('port', 8787));
const LIFETIME_S = Number(arg('lifetime', 30));
const RADIUS_M = Number(arg('radius', 50));
const VENUE_ID = arg('venue', 'venue-1');
const LOG_NAME = arg('log', 'trials');
const POLICY_VERSION = '1';
const VENUE_KEY = randomBytes(32);
const ADMIN_KEY = randomBytes(16).toString('hex');

const ARTIFACTS = join(here, 'artifacts');
const VKEY = JSON.parse(readFileSync(join(ARTIFACTS, 'zairn_zkp_vkey.json'), 'utf8'));
const LOG_DIR = join(here, 'logs');
mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = join(LOG_DIR, `${LOG_NAME}-${new Date().toISOString().slice(0, 10)}.jsonl`);

let center = null; // { lat, lon } in degrees, memory only
const sessions = new Map(); // sessionId -> { nonce, issuedAt, used, device, trialType }

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const currentSlot = () => Math.floor(Date.now() / 1000 / LIFETIME_S);
const macFor = (venueId, slot) =>
  b64url(createHmac('sha256', VENUE_KEY).update(`ZT1.${venueId}.${slot}`).digest()).slice(0, 22);

function checkToken(token) {
  const m = /^ZT1\.([A-Za-z0-9_-]{1,64})\.(\d{1,12})\.([A-Za-z0-9_-]{22})$/.exec(token ?? '');
  if (!m) return { ok: false, reason: 'token_malformed' };
  const [, venueId, slotStr, mac] = m;
  if (venueId !== VENUE_ID) return { ok: false, reason: 'token_wrong_venue' };
  const slot = Number(slotStr);
  const expected = Buffer.from(macFor(venueId, slot));
  if (!timingSafeEqual(expected, Buffer.from(mac))) return { ok: false, reason: 'token_bad_mac' };
  const age = currentSlot() - slot;
  if (age < 0 || age > 1) return { ok: false, reason: 'token_expired', slot, ageSlots: age };
  return { ok: true, slot, ageSlots: age, ageMs: Date.now() - slot * LIFETIME_S * 1000 };
}

function log(entry) {
  appendFileSync(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('body too large');
  }
  return body ? JSON.parse(body) : {};
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

const STATIC = {
  '/': join(here, 'public/index.html'),
  '/venue': join(here, 'public/venue.html'),
  // 1 Hz trace collector (needs HTTPS on phones, so it rides on the same tunnel).
  '/collect': join(geoDrop, 'test/collect-gps-trace.html'),
  '/lib/zkp.js': join(geoDrop, 'dist/zkp.js'),
  '/vendor/snarkjs.min.js': join(dirname(createRequire(join(geoDrop, 'package.json')).resolve('snarkjs')), 'snarkjs.min.js'),
  '/artifacts/zairn_zkp.wasm': join(ARTIFACTS, 'zairn_zkp_js/zairn_zkp.wasm'),
  '/artifacts/zairn_zkp_final.zkey': join(ARTIFACTS, 'zairn_zkp_final.zkey'),
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.zkey': 'application/octet-stream' };

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = normalize(url.pathname).replace(/\\/g, '/');

  if (req.method === 'GET' && STATIC[path]) {
    const file = STATIC[path];
    if (!existsSync(file)) return send(res, 404, { error: 'missing artifact', path });
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    return res.end(readFileSync(file));
  }

  if (req.method === 'GET' && path === '/api/config') {
    return send(res, 200, { venueId: VENUE_ID, radiusM: RADIUS_M, lifetimeS: LIFETIME_S, policyVersion: POLICY_VERSION, calibrated: !!center });
  }

  // The venue display is opened from the server machine (localhost), which
  // is the only place the venue key is handed out.
  if (req.method === 'GET' && path === '/api/venue-key') {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];
    if (!local) return send(res, 403, { error: 'venue key is only served to localhost' });
    return send(res, 200, { key: b64url(VENUE_KEY), venueId: VENUE_ID, lifetimeS: LIFETIME_S });
  }

  if (req.method === 'POST' && path === '/api/calibrate') {
    const body = await readJson(req);
    if (body.adminKey !== ADMIN_KEY) return send(res, 403, { error: 'bad admin key' });
    if (!Number.isFinite(body.lat) || !Number.isFinite(body.lon)) return send(res, 400, { error: 'lat/lon required' });
    center = { lat: body.lat, lon: body.lon };
    log({ event: 'calibrate', accuracy: body.accuracy ?? null });
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && path === '/api/session') {
    if (!center) return send(res, 409, { error: 'venue not calibrated' });
    const body = await readJson(req);
    const sessionId = b64url(randomBytes(12));
    const nonce = b64url(randomBytes(16));
    sessions.set(sessionId, { nonce, issuedAt: Date.now(), used: false, device: String(body.device ?? '').slice(0, 64), trialType: String(body.trialType ?? '').slice(0, 32) });
    return send(res, 200, { sessionId, nonce, venueId: VENUE_ID, policyVersion: POLICY_VERSION, radiusM: RADIUS_M, center });
  }

  if (req.method === 'POST' && path === '/api/verify') {
    const receivedAt = Date.now();
    const body = await readJson(req);
    const s = sessions.get(body.sessionId);
    const base = { event: 'verify', device: s?.device, trialType: s?.trialType, clientTimings: body.clientTimings ?? null, userAgent: req.headers['user-agent'] ?? null };
    const fail = (reason, extra = {}) => {
      log({ ...base, ok: false, reason, ...extra });
      return send(res, 200, { ok: false, reason, ...extra });
    };
    if (!s) return fail('unknown_session');
    if (s.used) return fail('session_reused');
    s.used = true;
    const elapsedMs = receivedAt - s.issuedAt;
    // Client-side failures (no GPS fix, outside the radius, camera denied)
    // count against the legitimate success rate, so they are logged too.
    if (body.clientError) return fail(`client_${String(body.clientError).slice(0, 64)}`, { elapsedMs });

    const tok = checkToken(body.token);
    if (!tok.ok) return fail(tok.reason, { elapsedMs, ageSlots: tok.ageSlots ?? null });

    const statement = await buildZkStatementBinding({
      dropId: VENUE_ID, policyVersion: POLICY_VERSION, epoch: tok.slot,
      serverNonce: lengthPrefixEncode(s.nonce, body.token),
    });
    if (!validatePublicSignals(body.publicSignals, center.lat, center.lon, RADIUS_M, statement)) {
      return fail('public_signals_mismatch', { elapsedMs });
    }
    const t0 = performance.now();
    let valid = false;
    try {
      valid = await snarkjs.groth16.verify(VKEY, body.publicSignals, body.proof);
    } catch {
      valid = false;
    }
    const verifyMs = performance.now() - t0;
    if (!valid) return fail('proof_invalid', { elapsedMs, verifyMs });
    log({ ...base, ok: true, reason: 'accepted', elapsedMs, verifyMs, tokenAgeMs: tok.ageMs, ageSlots: tok.ageSlots });
    return send(res, 200, { ok: true, reason: 'accepted', elapsedMs, verifyMs, tokenAgeMs: tok.ageMs });
  }

  send(res, 404, { error: 'not found' });
}

createServer((req, res) => {
  handle(req, res).catch((err) => send(res, 500, { error: String(err.message ?? err) }));
}).listen(PORT, () => {
  console.log(`step-up prototype on http://localhost:${PORT}`);
  console.log(`  venue display (open on this machine): http://localhost:${PORT}/venue`);
  console.log(`  phone pages (via the HTTPS tunnel):    /  (step-up trial)   /collect  (1 Hz trace collector)`);
  console.log(`  admin key for calibration:            ${ADMIN_KEY}`);
  console.log(`  token lifetime ${LIFETIME_S} s, radius ${RADIUS_M} m, log ${LOG_FILE}`);
});
