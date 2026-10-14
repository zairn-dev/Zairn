/**
 * SBPP End-to-End Unlock-Flow Latency Benchmark
 *
 * Measures the full GeoDrop unlock path with search-authorized-proof (SAP)
 * verification ON vs OFF, over a realistic drop corpus (OpenStreetMap POIs,
 * Tokyo metropolitan area). This is the deployment-facing counterpart to the
 * protocol-path microbenchmark (evaluate-sbpp-performance.mjs): it times the
 * work an unlock actually performs offline, end to end.
 *
 * Unlock path measured (per query, network I/O excluded — deterministic):
 *   OFF (pre-SBPP baseline): encrypted search (GridSE token match) → AES-GCM
 *        content decrypt. No authorization binding.
 *   ON  (SBPP): session-bound encrypted search (records the result-set digest
 *        + candidate set) → SAP verification (P1 authorization binding via the
 *        session nonce, P2 result-set soundness via candidate membership +
 *        result-set digest, P3 authorization provenance via server-issued,
 *        single-use session) → AES-GCM content decrypt.
 *
 * The ON−OFF delta isolates the added cost of search-authorization at unlock.
 * Statement/context binding (dropId/policyVersion/epoch) and sensor truth are
 * orthogonal layers and are not measured here.
 *
 * Deterministic: fixed seed (mulberry32). N ≥ 100 queries. Node.js 18+.
 * Output: JSON to stdout, summary table to stderr.
 *
 * Usage: node test/evaluate-sbpp-unlock-flow.mjs
 */

import { performance } from 'node:perf_hooks';
import { register } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Register resolve hook so extensionless relative imports in dist/ get .js appended
register('data:text/javascript,' + encodeURIComponent(`
export function resolve(specifier, context, next) {
  if (
    context.parentURL &&
    context.parentURL.includes('/dist/') &&
    specifier.startsWith('.') &&
    !specifier.endsWith('.js') &&
    !specifier.endsWith('.mjs') &&
    !specifier.endsWith('.json')
  ) {
    return next(specifier + '.js', context);
  }
  return next(specifier, context);
}
`));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dynamic imports so the resolve hook is active when dist/ modules load
const { generateIndexTokens, generateSearchTokens, matchTokens } =
  await import('../dist/encrypted-search.js');
const { SbppSessionStore, sbppMatch, buildSbppChallengeDigest, sbppVerifyBinding, MerkleResultSet } =
  await import('../dist/sbpp.js');
const { encrypt, decrypt, deriveLocationKey, CURRENT_KEY_VERSION } =
  await import('../dist/crypto.js');
const { encodeGeohash } =
  await import('../dist/geofence.js');

// =====================
// Configuration
// =====================

const SEED = 42;
const N_INDEXED = 5000;      // drops indexed into the encrypted search corpus
const N_QUERIES = 200;       // measured unlock queries (>= 100)
const WARMUP = 50;
const SEARCH_RADIUS_M = 1000;
const SEARCH_KEY = 'sbpp-unlock-flow-eval-key-2026';
const PRECISION_LEVELS = [4, 5, 6];
const SERVER_SECRET = 'unlock-flow-eval-server-secret';
const POLICY_VERSION = '1';
const EPOCH = '1';
const DROP_CONTENT = 'geo-drop payload: ' + 'x'.repeat(256);
const CACHE_FILE = path.join(__dirname, 'osm-tokyo-pois.json');

const config = { searchKey: SEARCH_KEY, precisionLevels: PRECISION_LEVELS };

// =====================
// Helpers
// =====================

// mulberry32 seeded PRNG — deterministic across runs
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randHex(rnd, bytes) {
  let s = '';
  for (let i = 0; i < bytes; i++) s += Math.floor(rnd() * 256).toString(16).padStart(2, '0');
  return s;
}

function computeStats(samples) {
  const sorted = Float64Array.from(samples).sort();
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    median_us: sorted[Math.floor(n * 0.5)],
    mean_us: sum / n,
    p95_us: sorted[Math.floor(n * 0.95)],
    p99_us: sorted[Math.floor(n * 0.99)],
  };
}

function round2(x) { return Math.round(x * 100) / 100; }

function fmtStats(s) {
  return {
    median_us: round2(s.median_us),
    mean_us: round2(s.mean_us),
    p95_us: round2(s.p95_us),
    p99_us: round2(s.p99_us),
  };
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// =====================
// Corpus setup
// =====================

async function buildCorpus() {
  const pois = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));

  // Deterministic partial Fisher–Yates sample of N_INDEXED unique POIs
  const rnd = mulberry32(SEED);
  const idx = Array.from({ length: pois.length }, (_, i) => i);
  const take = Math.min(N_INDEXED, pois.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rnd() * (pois.length - i));
    const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
  }
  const sampled = idx.slice(0, take).map((i) => pois[i]);

  process.stderr.write(`Indexing ${sampled.length} drops (encrypted search + AES-GCM payloads)...\n`);

  const indexedDrops = [];   // { dropId, tokens } — server-side encrypted index
  const byId = new Map();     // dropId -> { geohash, key, payload, lat, lon }
  for (const p of sampled) {
    const dropId = p.id;
    const geohash = encodeGeohash(p.lat, p.lon, 5);
    const tokens = await generateIndexTokens(p.lat, p.lon, config);
    const encSalt = randHex(rnd, 16);
    const key = deriveLocationKey(geohash, dropId, encSalt, SERVER_SECRET, CURRENT_KEY_VERSION);
    const payload = await encrypt(DROP_CONTENT, key);
    indexedDrops.push({ dropId, tokens });
    byId.set(dropId, { geohash, key, payload, lat: p.lat, lon: p.lon });
  }

  // Deterministic query locations: near a sampled drop (~50m jitter)
  const queries = [];
  for (let q = 0; q < N_QUERIES; q++) {
    const pivot = sampled[Math.floor(rnd() * sampled.length)];
    queries.push({
      lat: pivot.lat + (rnd() - 0.5) * 0.001,
      lon: pivot.lon + (rnd() - 0.5) * 0.001,
      pivotId: pivot.id,
    });
  }

  return { indexedDrops, byId, queries };
}

// =====================
// Unlock-path runners
// =====================

// OFF: pre-SBPP baseline — encrypted search + decrypt, no authorization binding.
async function unlockOff(q, indexedDrops, byId) {
  const st = await generateSearchTokens(q.lat, q.lon, SEARCH_RADIUS_M, config);
  const matches = matchTokens(st, indexedDrops);
  const target = matches.length ? matches[0].dropId : q.pivotId;
  const rec = byId.get(target);
  await decrypt(rec.payload, rec.key);
  return matches.length;
}

// ON: SBPP — session-bound search + SAP verification (P1/P2/P3) + decrypt.
async function unlockOn(q, indexedDrops, byId, store) {
  const session = store.issue();
  const st = await generateSearchTokens(q.lat, q.lon, SEARCH_RADIUS_M, config);
  const matches = sbppMatch(st, indexedDrops, store, session.sessionId, session.nonce);
  const target = matches.length ? matches[0].dropId : q.pivotId;
  const digest = buildSbppChallengeDigest({
    dropId: target,
    policyVersion: POLICY_VERSION,
    epoch: EPOCH,
    sessionNonce: session.nonce,
    resultSetDigest: store.getResultDigest(session.sessionId),
  });
  const authz = sbppVerifyBinding(
    store, session.sessionId, session.nonce, digest, target, POLICY_VERSION, EPOCH,
  );
  if (!authz.valid) throw new Error(`honest path rejected: ${authz.reason}`);
  const rec = byId.get(target);
  await decrypt(rec.payload, rec.key);
  return matches.length;
}

// =====================
// Main
// =====================

async function main() {
  const { indexedDrops, byId, queries } = await buildCorpus();

  // Result-set size distribution (characterises the corpus density)
  const rsSizes = [];
  for (const q of queries) {
    const st = await generateSearchTokens(q.lat, q.lon, SEARCH_RADIUS_M, config);
    rsSizes.push(matchTokens(st, indexedDrops).length);
  }
  const avgRs = rsSizes.reduce((a, b) => a + b, 0) / rsSizes.length;

  // Warmup (JIT + Web Crypto)
  const store = new SbppSessionStore();
  for (let w = 0; w < WARMUP; w++) {
    const q = queries[w % queries.length];
    await unlockOff(q, indexedDrops, byId);
    await unlockOn(q, indexedDrops, byId, store);
  }

  process.stderr.write(`Timing ${N_QUERIES} unlock queries (OFF vs ON)...\n`);

  // Full unlock path — OFF
  const offSamples = [];
  for (let i = 0; i < N_QUERIES; i++) {
    const q = queries[i];
    const t0 = performance.now();
    await unlockOff(q, indexedDrops, byId);
    offSamples.push((performance.now() - t0) * 1000); // ms -> us
  }

  // Full unlock path — ON
  let honestValid = 0;
  const onSamples = [];
  for (let i = 0; i < N_QUERIES; i++) {
    const q = queries[i];
    const t0 = performance.now();
    const n = await unlockOn(q, indexedDrops, byId, store);
    onSamples.push((performance.now() - t0) * 1000);
    if (n >= 0) honestValid++; // unlockOn throws if authz invalid
  }

  // Isolated SAP verification (pure P1/P2/P3 authorization check): pre-populate
  // sessions + digests (untimed), then time only build-digest + verify-binding.
  const prep = [];
  for (let i = 0; i < N_QUERIES; i++) {
    const q = queries[i];
    const session = store.issue();
    const st = await generateSearchTokens(q.lat, q.lon, SEARCH_RADIUS_M, config);
    const matches = sbppMatch(st, indexedDrops, store, session.sessionId, session.nonce);
    const target = matches.length ? matches[0].dropId : q.pivotId;
    prep.push({ session, target, candidates: matches.map((m) => m.dropId) });
  }
  const sapSamples = [];
  for (const p of prep) {
    const t0 = performance.now();
    const digest = buildSbppChallengeDigest({
      dropId: p.target, policyVersion: POLICY_VERSION, epoch: EPOCH,
      sessionNonce: p.session.nonce, resultSetDigest: store.getResultDigest(p.session.sessionId),
    });
    sbppVerifyBinding(store, p.session.sessionId, p.session.nonce, digest, p.target, POLICY_VERSION, EPOCH);
    sapSamples.push((performance.now() - t0) * 1000);
  }

  // Isolated transcript-level P2 audit: Merkle result-set membership proof
  // (build tree over candidate set, prove target, verify proof).
  const merkleSamples = [];
  for (const p of prep) {
    const t0 = performance.now();
    const tree = new MerkleResultSet(p.candidates);
    const proof = tree.prove(p.target);
    if (proof) MerkleResultSet.verify(proof);
    merkleSamples.push((performance.now() - t0) * 1000);
  }

  // Negative control: the gate must reject a tampered (foreign) nonce.
  let tamperedRejected = 0;
  const negStore = new SbppSessionStore();
  const NEG = Math.min(50, N_QUERIES);
  for (let i = 0; i < NEG; i++) {
    const q = queries[i];
    const session = negStore.issue();
    const st = await generateSearchTokens(q.lat, q.lon, SEARCH_RADIUS_M, config);
    const matches = sbppMatch(st, indexedDrops, negStore, session.sessionId, session.nonce);
    const target = matches.length ? matches[0].dropId : q.pivotId;
    // Attacker forges a digest with a different session's nonce
    const foreign = negStore.issue();
    const digest = buildSbppChallengeDigest({
      dropId: target, policyVersion: POLICY_VERSION, epoch: EPOCH,
      sessionNonce: foreign.nonce, resultSetDigest: negStore.getResultDigest(session.sessionId),
    });
    const authz = sbppVerifyBinding(
      negStore, session.sessionId, session.nonce, digest, target, POLICY_VERSION, EPOCH,
    );
    if (!authz.valid) tamperedRejected++;
  }

  const off = computeStats(offSamples);
  const on = computeStats(onSamples);
  const sap = computeStats(sapSamples);
  const merkle = computeStats(merkleSamples);

  const onVsOffAbs = on.median_us - off.median_us;
  const onVsOffPct = (onVsOffAbs / off.median_us) * 100;
  const sapShare = (sap.median_us / on.median_us) * 100;

  const result = {
    timestamp: new Date().toISOString(),
    description:
      'End-to-end GeoDrop unlock-flow latency: search-authorized-proof (SAP) '
      + 'verification ON vs OFF over an OSM POI corpus (Tokyo). Network I/O excluded.',
    hardware_note: `Node.js ${process.version}, consumer x86-64. Times in microseconds.`,
    parameters: {
      seed: SEED,
      indexed_drops: indexedDrops.length,
      queries: N_QUERIES,
      warmup: WARMUP,
      search_radius_m: SEARCH_RADIUS_M,
      precision_levels: PRECISION_LEVELS,
      key_derivation_version: CURRENT_KEY_VERSION,
      content_bytes: DROP_CONTENT.length,
      cipher: 'AES-256-GCM (PBKDF2-SHA256, 100k iterations)',
    },
    corpus: {
      source: 'OpenStreetMap POIs, Tokyo metropolitan area (osm-tokyo-pois.json)',
      total_pois: JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')).length,
      sampled_indexed: indexedDrops.length,
      result_set_size_mean: round2(avgRs),
      result_set_size_median: median(rsSizes),
    },
    unlock_off: fmtStats(off),   // GridSE search + AES-GCM decrypt, no authorization
    unlock_on: fmtStats(on),     // SBPP session search + SAP verify (P1/P2/P3) + decrypt
    sap_verify_isolated: fmtStats(sap),       // pure P1/P2/P3 authorization check
    merkle_audit_isolated: fmtStats(merkle),  // transcript-level P2 membership proof
    overhead: {
      on_vs_off_abs_us_median: round2(onVsOffAbs),
      on_vs_off_pct_median: round2(onVsOffPct),
      sap_verify_median_us: round2(sap.median_us),
      sap_verify_share_of_unlock_pct_median: round2(sapShare),
    },
    correctness: {
      honest_path_all_valid: honestValid === N_QUERIES,
      honest_checks: N_QUERIES,
      tampered_nonce_all_rejected: tamperedRejected === NEG,
      tampered_checks: NEG,
    },
  };

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  // Summary to stderr
  const W = 14;
  const hdr = (s) => s.padStart(W);
  const val = (v) => String(round2(v)).padStart(W);
  const row = (label, s) => `${label.padEnd(24)}${val(s.median_us)}${val(s.mean_us)}${val(s.p95_us)}${val(s.p99_us)}\n`;
  process.stderr.write('\n=== SBPP Unlock-Flow Latency (microseconds) ===\n\n');
  process.stderr.write(`${''.padStart(24)}${hdr('median')}${hdr('mean')}${hdr('p95')}${hdr('p99')}\n`);
  process.stderr.write(row('Unlock OFF (baseline)', off));
  process.stderr.write(row('Unlock ON (SBPP)', on));
  process.stderr.write(row('  SAP verify (isolated)', sap));
  process.stderr.write(row('  Merkle audit (isolated)', merkle));
  process.stderr.write(`\nON vs OFF: +${round2(onVsOffAbs)} us (${round2(onVsOffPct)}%) at median\n`);
  process.stderr.write(`SAP verify share of unlock: ${round2(sapShare)}% at median\n`);
  process.stderr.write(`Correctness: honest ${honestValid}/${N_QUERIES} valid, tampered ${tamperedRejected}/${NEG} rejected\n\n`);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
