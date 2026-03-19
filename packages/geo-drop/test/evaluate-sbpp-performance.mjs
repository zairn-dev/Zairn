/**
 * SBPP Performance Benchmark
 *
 * Measures end-to-end latency of three search approaches:
 *   1. Plaintext geohash search (baseline)
 *   2. GridSE-only encrypted search
 *   3. SBPP (GridSE + session + challenge digest)
 *
 * Output: JSON to stdout, summary table to stderr.
 * Usage: node evaluate-sbpp-performance.mjs
 */

import { performance } from 'node:perf_hooks';
import { register } from 'node:module';

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

// Dynamic imports so the resolve hook is active when dist/ modules load
const { generateIndexTokens, generateSearchTokens, matchTokens, selectPrecisionForRadius } =
  await import('../dist/encrypted-search.js');
const { createSession, SbppSessionStore, buildSbppChallengeDigest } =
  await import('../dist/sbpp.js');
const { encodeGeohash, geohashNeighbors } =
  await import('../dist/geofence.js');

// =====================
// Configuration
// =====================

const NUM_DROPS = 1000;
const NUM_QUERIES = 100;
const ITERATIONS = 1000;
const WARMUP = 100;
const SEARCH_RADIUS_M = 1000;
const SEARCH_KEY = 'benchmark-key';

// Tokyo area bounds
const LAT_MIN = 35.6;
const LAT_MAX = 35.8;
const LON_MIN = 139.6;
const LON_MAX = 139.9;

// =====================
// Helpers
// =====================

function randomLat() {
  return LAT_MIN + Math.random() * (LAT_MAX - LAT_MIN);
}

function randomLon() {
  return LON_MIN + Math.random() * (LON_MAX - LON_MIN);
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

function round2(x) {
  return Math.round(x * 100) / 100;
}

function fmtStats(s) {
  return {
    median_us: round2(s.median_us),
    mean_us: round2(s.mean_us),
    p95_us: round2(s.p95_us),
    p99_us: round2(s.p99_us),
  };
}

// =====================
// Data generation
// =====================

async function generateDrops() {
  const config = { searchKey: SEARCH_KEY };
  const drops = [];
  for (let i = 0; i < NUM_DROPS; i++) {
    const lat = randomLat();
    const lon = randomLon();
    const geohash = encodeGeohash(lat, lon, 5);
    const tokens = await generateIndexTokens(lat, lon, config);
    drops.push({
      dropId: `drop-${i}`,
      lat,
      lon,
      geohash,
      tokens,
    });
  }
  return drops;
}

function generateSearchLocations() {
  const locs = [];
  for (let i = 0; i < NUM_QUERIES; i++) {
    locs.push({ lat: randomLat(), lon: randomLon() });
  }
  return locs;
}

// =====================
// Benchmark runners
// =====================

async function benchPlaintext(drops, searchLocs) {
  const dropGeohashes = drops.map((d) => d.geohash);
  const samples = [];

  // warmup
  for (let w = 0; w < WARMUP; w++) {
    const loc = searchLocs[w % searchLocs.length];
    const gh = encodeGeohash(loc.lat, loc.lon, 5);
    const neighbors = geohashNeighbors(gh);
    const cells = new Set([gh, ...neighbors]);
    for (const dgh of dropGeohashes) {
      cells.has(dgh);
    }
  }

  for (let i = 0; i < ITERATIONS; i++) {
    const loc = searchLocs[i % searchLocs.length];
    const t0 = performance.now();
    const gh = encodeGeohash(loc.lat, loc.lon, 5);
    const neighbors = geohashNeighbors(gh);
    const cells = new Set([gh, ...neighbors]);
    for (const dgh of dropGeohashes) {
      cells.has(dgh);
    }
    const t1 = performance.now();
    samples.push((t1 - t0) * 1000); // ms -> us
  }

  return computeStats(samples);
}

async function benchGridSE(drops, searchLocs) {
  const config = { searchKey: SEARCH_KEY };
  const indexedDrops = drops.map((d) => ({ dropId: d.dropId, tokens: d.tokens }));

  const tokenGenSamples = [];
  const matchingSamples = [];
  const totalSamples = [];

  // warmup
  for (let w = 0; w < WARMUP; w++) {
    const loc = searchLocs[w % searchLocs.length];
    const st = await generateSearchTokens(loc.lat, loc.lon, SEARCH_RADIUS_M, config);
    matchTokens(st, indexedDrops);
  }

  for (let i = 0; i < ITERATIONS; i++) {
    const loc = searchLocs[i % searchLocs.length];

    const t0 = performance.now();
    const st = await generateSearchTokens(loc.lat, loc.lon, SEARCH_RADIUS_M, config);
    const t1 = performance.now();
    matchTokens(st, indexedDrops);
    const t2 = performance.now();

    tokenGenSamples.push((t1 - t0) * 1000);
    matchingSamples.push((t2 - t1) * 1000);
    totalSamples.push((t2 - t0) * 1000);
  }

  return {
    token_gen: computeStats(tokenGenSamples),
    matching: computeStats(matchingSamples),
    total: computeStats(totalSamples),
  };
}

async function benchSBPP(drops, searchLocs) {
  const config = { searchKey: SEARCH_KEY };
  const indexedDrops = drops.map((d) => ({ dropId: d.dropId, tokens: d.tokens }));

  const sessionSamples = [];
  const tokenGenSamples = [];
  const matchingSamples = [];
  const digestSamples = [];
  const totalSamples = [];

  // warmup
  for (let w = 0; w < WARMUP; w++) {
    const loc = searchLocs[w % searchLocs.length];
    const session = createSession();
    const st = await generateSearchTokens(loc.lat, loc.lon, SEARCH_RADIUS_M, config);
    const matches = matchTokens(st, indexedDrops);
    if (matches.length > 0) {
      buildSbppChallengeDigest({
        dropId: matches[0].dropId,
        policyVersion: '1',
        epoch: '2026-03-19',
        sessionNonce: session.nonce,
      });
    }
  }

  for (let i = 0; i < ITERATIONS; i++) {
    const loc = searchLocs[i % searchLocs.length];

    const t0 = performance.now();
    const session = createSession();
    const t1 = performance.now();
    const st = await generateSearchTokens(loc.lat, loc.lon, SEARCH_RADIUS_M, config);
    const t2 = performance.now();
    const matches = matchTokens(st, indexedDrops);
    const t3 = performance.now();
    // Always compute digest (use a synthetic dropId if no matches)
    const targetDropId = matches.length > 0 ? matches[0].dropId : 'drop-0';
    buildSbppChallengeDigest({
      dropId: targetDropId,
      policyVersion: '1',
      epoch: '2026-03-19',
      sessionNonce: session.nonce,
    });
    const t4 = performance.now();

    sessionSamples.push((t1 - t0) * 1000);
    tokenGenSamples.push((t2 - t1) * 1000);
    matchingSamples.push((t3 - t2) * 1000);
    digestSamples.push((t4 - t3) * 1000);
    totalSamples.push((t4 - t0) * 1000);
  }

  return {
    session_create: computeStats(sessionSamples),
    token_gen: computeStats(tokenGenSamples),
    matching: computeStats(matchingSamples),
    digest: computeStats(digestSamples),
    total: computeStats(totalSamples),
  };
}

async function benchIndividualOps() {
  const config = { searchKey: SEARCH_KEY };
  const store = new SbppSessionStore();

  // Session creation
  const sessionSamples = [];
  for (let w = 0; w < WARMUP; w++) createSession();
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    createSession();
    const t1 = performance.now();
    sessionSamples.push((t1 - t0) * 1000);
  }

  // Single HMAC token generation
  const hmacSamples = [];
  for (let w = 0; w < WARMUP; w++) {
    await generateSearchTokens(35.7, 139.7, SEARCH_RADIUS_M, config);
  }
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    await generateSearchTokens(35.7, 139.7, SEARCH_RADIUS_M, config);
    const t1 = performance.now();
    hmacSamples.push((t1 - t0) * 1000);
  }

  // Challenge digest
  const digestSamples = [];
  const ctx = {
    dropId: 'drop-0',
    policyVersion: '1',
    epoch: '2026-03-19',
    sessionNonce: 'a'.repeat(64),
  };
  for (let w = 0; w < WARMUP; w++) buildSbppChallengeDigest(ctx);
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    buildSbppChallengeDigest(ctx);
    const t1 = performance.now();
    digestSamples.push((t1 - t0) * 1000);
  }

  // Session validation
  const validationSamples = [];
  for (let w = 0; w < WARMUP; w++) {
    const s = store.issue();
    store.validate(s.sessionId, s.nonce);
  }
  // Pre-create sessions for validation benchmark
  const sessions = [];
  for (let i = 0; i < ITERATIONS; i++) sessions.push(store.issue());
  for (let i = 0; i < ITERATIONS; i++) {
    const s = sessions[i];
    const t0 = performance.now();
    store.validate(s.sessionId, s.nonce);
    const t1 = performance.now();
    validationSamples.push((t1 - t0) * 1000);
  }

  return {
    session_create: computeStats(sessionSamples),
    hmac_token_gen: computeStats(hmacSamples),
    challenge_digest: computeStats(digestSamples),
    session_validation: computeStats(validationSamples),
  };
}

// =====================
// Main
// =====================

async function main() {
  process.stderr.write('Generating synthetic drops...\n');
  const drops = await generateDrops();
  const searchLocs = generateSearchLocations();
  process.stderr.write(`Generated ${drops.length} drops, ${searchLocs.length} search locations\n\n`);

  process.stderr.write('Benchmarking plaintext search...\n');
  const plaintext = await benchPlaintext(drops, searchLocs);

  process.stderr.write('Benchmarking GridSE search...\n');
  const gridse = await benchGridSE(drops, searchLocs);

  process.stderr.write('Benchmarking SBPP search...\n');
  const sbpp = await benchSBPP(drops, searchLocs);

  process.stderr.write('Benchmarking individual operations...\n');
  const individual = await benchIndividualOps();

  // Compute overhead percentages (based on median)
  const gridseVsPlaintext = ((gridse.total.median_us - plaintext.median_us) / plaintext.median_us) * 100;
  const sbppVsGridse = ((sbpp.total.median_us - gridse.total.median_us) / gridse.total.median_us) * 100;
  const sbppVsPlaintext = ((sbpp.total.median_us - plaintext.median_us) / plaintext.median_us) * 100;

  const result = {
    timestamp: new Date().toISOString(),
    drops: NUM_DROPS,
    queries: NUM_QUERIES,
    iterations: ITERATIONS,
    plaintext: fmtStats(plaintext),
    gridse: {
      token_gen: fmtStats(gridse.token_gen),
      matching: fmtStats(gridse.matching),
      total: fmtStats(gridse.total),
    },
    sbpp: {
      session_create: fmtStats(sbpp.session_create),
      token_gen: fmtStats(sbpp.token_gen),
      matching: fmtStats(sbpp.matching),
      digest: fmtStats(sbpp.digest),
      total: fmtStats(sbpp.total),
    },
    individual: {
      session_create: fmtStats(individual.session_create),
      hmac_token_gen: fmtStats(individual.hmac_token_gen),
      challenge_digest: fmtStats(individual.challenge_digest),
      session_validation: fmtStats(individual.session_validation),
    },
    overhead: {
      gridse_vs_plaintext_pct: round2(gridseVsPlaintext),
      sbpp_vs_gridse_pct: round2(sbppVsGridse),
      sbpp_vs_plaintext_pct: round2(sbppVsPlaintext),
    },
  };

  // JSON to stdout
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  // Summary table to stderr
  const W = 14;
  const hdr = (s) => s.padStart(W);
  const val = (v) => String(round2(v)).padStart(W);

  process.stderr.write('\n=== SBPP Performance Benchmark Results ===\n\n');

  process.stderr.write('--- End-to-End Latency (microseconds) ---\n');
  process.stderr.write(
    `${''.padStart(20)}${hdr('median')}${hdr('mean')}${hdr('p95')}${hdr('p99')}\n`,
  );
  const row = (label, s) =>
    `${label.padEnd(20)}${val(s.median_us)}${val(s.mean_us)}${val(s.p95_us)}${val(s.p99_us)}\n`;
  process.stderr.write(row('Plaintext', plaintext));
  process.stderr.write(row('GridSE total', gridse.total));
  process.stderr.write(row('  token gen', gridse.token_gen));
  process.stderr.write(row('  matching', gridse.matching));
  process.stderr.write(row('SBPP total', sbpp.total));
  process.stderr.write(row('  session create', sbpp.session_create));
  process.stderr.write(row('  token gen', sbpp.token_gen));
  process.stderr.write(row('  matching', sbpp.matching));
  process.stderr.write(row('  digest', sbpp.digest));

  process.stderr.write('\n--- Individual Operations (microseconds) ---\n');
  process.stderr.write(
    `${''.padStart(20)}${hdr('median')}${hdr('mean')}${hdr('p95')}${hdr('p99')}\n`,
  );
  process.stderr.write(row('Session create', individual.session_create));
  process.stderr.write(row('HMAC token gen', individual.hmac_token_gen));
  process.stderr.write(row('Challenge digest', individual.challenge_digest));
  process.stderr.write(row('Session validate', individual.session_validation));

  process.stderr.write('\n--- Overhead ---\n');
  process.stderr.write(`GridSE vs Plaintext: ${round2(gridseVsPlaintext)}%\n`);
  process.stderr.write(`SBPP vs GridSE:      ${round2(sbppVsGridse)}%\n`);
  process.stderr.write(`SBPP vs Plaintext:   ${round2(sbppVsPlaintext)}%\n`);
  process.stderr.write('\n');
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
