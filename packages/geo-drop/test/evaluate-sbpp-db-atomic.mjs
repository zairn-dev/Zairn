/**
 * SBPP DB-Backed Atomic Session Consumption Evaluation
 *
 * Simulates PostgreSQL-style atomic session consumption using a shared
 * Map + async mutex pattern. Verifies that exactly one verification
 * succeeds per session under concurrent load.
 *
 * Paper section: Session atomicity under concurrent double-submit
 *
 * Usage:
 *   node packages/geo-drop/test/evaluate-sbpp-db-atomic.mjs
 */

import {
  SbppSessionStore,
  buildSbppChallengeDigest,
  sbppVerifyBinding,
} from '../dist/sbpp.js';

// ═══════════════════════════════════════════════════════
// Parameters
// ═══════════════════════════════════════════════════════

const N = 1000;
const THROUGHPUT_N = 10000;
const CONCURRENT_THROUGHPUT_N = 1000;
const BATCH_SIZE = 50;

const DROP_ID = 'drop-atomic-test-0001';
const POLICY_VERSION = '1';
const EPOCH = '2026-03-21';

// ═══════════════════════════════════════════════════════
// Async Mutex — simulates DB row-level lock
// ═══════════════════════════════════════════════════════

class AsyncMutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise((resolve) => {
      this._queue.push(resolve);
    });
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }
}

// ═══════════════════════════════════════════════════════
// Atomic session store — wraps SbppSessionStore with mutex
// ═══════════════════════════════════════════════════════

class AtomicSessionStore {
  constructor() {
    this._store = new SbppSessionStore();
    this._locks = new Map(); // sessionId → AsyncMutex
  }

  issue(options) {
    const session = this._store.issue(options);
    this._locks.set(session.sessionId, new AsyncMutex());
    return session;
  }

  /**
   * Atomic verify-and-consume: acquires a per-session mutex before
   * calling sbppVerifyBinding (which internally validates + consumes).
   */
  async atomicVerify(session, digest) {
    const mutex = this._locks.get(session.sessionId);
    if (!mutex) return { valid: false, reason: 'no_mutex' };

    await mutex.acquire();
    try {
      return sbppVerifyBinding(
        this._store,
        session.sessionId,
        session.nonce,
        digest,
        DROP_ID,
        POLICY_VERSION,
        EPOCH,
      );
    } finally {
      mutex.release();
    }
  }

  get size() {
    return this._store.size;
  }
}

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function buildDigest(nonce) {
  return buildSbppChallengeDigest({
    dropId: DROP_ID,
    policyVersion: POLICY_VERSION,
    epoch: EPOCH,
    sessionNonce: nonce,
  });
}

function verify(store, session, digest) {
  return sbppVerifyBinding(
    store,
    session.sessionId,
    session.nonce,
    digest,
    DROP_ID,
    POLICY_VERSION,
    EPOCH,
  );
}

// ═══════════════════════════════════════════════════════
// Scenario 1: Sequential consume
// ═══════════════════════════════════════════════════════

function runSequentialConsume(n) {
  let firstSuccess = 0;
  let secondFail = 0;

  for (let i = 0; i < n; i++) {
    const store = new SbppSessionStore();
    const session = store.issue();
    const digest = buildDigest(session.nonce);

    const first = verify(store, session, digest);
    if (first.valid) firstSuccess++;

    const second = verify(store, session, digest);
    if (!second.valid) secondFail++;
  }

  return { first_success: firstSuccess, second_fail: secondFail };
}

// ═══════════════════════════════════════════════════════
// Scenario 2: Concurrent double-submit (k=2) with mutex
// ═══════════════════════════════════════════════════════

async function runConcurrentDouble(n) {
  let exactlyOne = 0;
  let both = 0;
  let neither = 0;

  for (let i = 0; i < n; i++) {
    const store = new AtomicSessionStore();
    const session = store.issue();
    const digest = buildDigest(session.nonce);

    const [r1, r2] = await Promise.all([
      store.atomicVerify(session, digest),
      store.atomicVerify(session, digest),
    ]);

    const successes = (r1.valid ? 1 : 0) + (r2.valid ? 1 : 0);
    if (successes === 1) exactlyOne++;
    else if (successes === 2) both++;
    else neither++;
  }

  return {
    exactly_one: exactlyOne,
    both,
    neither,
    rate: Number((exactlyOne / n).toFixed(4)),
  };
}

// ═══════════════════════════════════════════════════════
// Scenario 3: Concurrent multi-submit (k=5) with mutex
// ═══════════════════════════════════════════════════════

async function runConcurrentMulti(n, k = 5) {
  let exactlyOne = 0;
  let moreThanOne = 0;
  let zero = 0;

  for (let i = 0; i < n; i++) {
    const store = new AtomicSessionStore();
    const session = store.issue();
    const digest = buildDigest(session.nonce);

    const results = await Promise.all(
      Array.from({ length: k }, () => store.atomicVerify(session, digest)),
    );

    const successes = results.filter((r) => r.valid).length;
    if (successes === 1) exactlyOne++;
    else if (successes > 1) moreThanOne++;
    else zero++;
  }

  return {
    exactly_one: exactlyOne,
    more_than_one: moreThanOne,
    zero,
    rate: Number((exactlyOne / n).toFixed(4)),
  };
}

// ═══════════════════════════════════════════════════════
// Scenario 4: Sequential throughput
// ═══════════════════════════════════════════════════════

function runSequentialThroughput(n) {
  const store = new SbppSessionStore();
  const sessions = [];

  // Issue all sessions
  for (let i = 0; i < n; i++) {
    sessions.push(store.issue());
  }

  // Verify all sequentially
  const start = performance.now();
  let verified = 0;
  for (const session of sessions) {
    const digest = buildDigest(session.nonce);
    const result = verify(store, session, digest);
    if (result.valid) verified++;
  }
  const elapsed = performance.now() - start;

  return {
    sessions: n,
    verified,
    elapsed_ms: Number(elapsed.toFixed(2)),
    sessions_per_sec: Number((n / (elapsed / 1000)).toFixed(0)),
  };
}

// ═══════════════════════════════════════════════════════
// Scenario 5: Concurrent throughput (batched)
// ═══════════════════════════════════════════════════════

async function runConcurrentThroughput(n, batchSize) {
  const store = new AtomicSessionStore();
  const sessions = [];

  // Issue all sessions
  for (let i = 0; i < n; i++) {
    sessions.push(store.issue());
  }

  const start = performance.now();
  let verified = 0;

  // Process in batches
  for (let i = 0; i < sessions.length; i += batchSize) {
    const batch = sessions.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((session) => {
        const digest = buildDigest(session.nonce);
        return store.atomicVerify(session, digest);
      }),
    );
    verified += results.filter((r) => r.valid).length;
  }

  const elapsed = performance.now() - start;

  return {
    sessions: n,
    verified,
    batch_size: batchSize,
    elapsed_ms: Number(elapsed.toFixed(2)),
    sessions_per_sec: Number((n / (elapsed / 1000)).toFixed(0)),
  };
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════

async function main() {
  process.stderr.write(`=== SBPP DB-Atomic Session Consumption (N=${N}) ===\n\n`);

  // Scenario 1
  process.stderr.write('Scenario 1: Sequential consume...\n');
  const sequential = runSequentialConsume(N);
  process.stderr.write(
    `  first_success=${sequential.first_success}/${N}  second_fail=${sequential.second_fail}/${N}\n\n`,
  );

  // Scenario 2
  process.stderr.write('Scenario 2: Concurrent double-submit (k=2)...\n');
  const concurrent2 = await runConcurrentDouble(N);
  process.stderr.write(
    `  exactly_one=${concurrent2.exactly_one}  both=${concurrent2.both}  neither=${concurrent2.neither}  rate=${concurrent2.rate}\n\n`,
  );

  // Scenario 3
  process.stderr.write('Scenario 3: Concurrent multi-submit (k=5)...\n');
  const concurrent5 = await runConcurrentMulti(N, 5);
  process.stderr.write(
    `  exactly_one=${concurrent5.exactly_one}  more_than_one=${concurrent5.more_than_one}  zero=${concurrent5.zero}  rate=${concurrent5.rate}\n\n`,
  );

  // Scenario 4
  process.stderr.write(`Scenario 4: Sequential throughput (N=${THROUGHPUT_N})...\n`);
  const seqThroughput = runSequentialThroughput(THROUGHPUT_N);
  process.stderr.write(
    `  verified=${seqThroughput.verified}/${THROUGHPUT_N}  ${seqThroughput.sessions_per_sec} sessions/sec\n\n`,
  );

  // Scenario 5
  process.stderr.write(
    `Scenario 5: Concurrent throughput (N=${CONCURRENT_THROUGHPUT_N}, batch=${BATCH_SIZE})...\n`,
  );
  const concThroughput = await runConcurrentThroughput(CONCURRENT_THROUGHPUT_N, BATCH_SIZE);
  process.stderr.write(
    `  verified=${concThroughput.verified}/${CONCURRENT_THROUGHPUT_N}  ${concThroughput.sessions_per_sec} sessions/sec\n\n`,
  );

  const output = {
    timestamp: new Date().toISOString(),
    sequential: {
      first_success: sequential.first_success,
      second_fail: sequential.second_fail,
    },
    concurrent_2: {
      exactly_one: concurrent2.rate,
    },
    concurrent_5: {
      exactly_one: concurrent5.rate,
    },
    sequential_throughput: {
      sessions_per_sec: Number(seqThroughput.sessions_per_sec),
    },
    concurrent_throughput: {
      sessions_per_sec: Number(concThroughput.sessions_per_sec),
      batch_size: BATCH_SIZE,
    },
  };

  console.log(JSON.stringify(output, null, 2));

  // Summary
  process.stderr.write('=== Summary ===\n');
  process.stderr.write(
    `  Sequential: first=${sequential.first_success}/${N} second_fail=${sequential.second_fail}/${N}\n`,
  );
  process.stderr.write(`  Concurrent k=2: exactly_one rate=${concurrent2.rate}\n`);
  process.stderr.write(`  Concurrent k=5: exactly_one rate=${concurrent5.rate}\n`);
  process.stderr.write(
    `  Seq throughput: ${seqThroughput.sessions_per_sec} sess/s\n`,
  );
  process.stderr.write(
    `  Conc throughput: ${concThroughput.sessions_per_sec} sess/s (batch=${BATCH_SIZE})\n`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
