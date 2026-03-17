/**
 * Strategy 2c: Stored-Digest Per-Request Nonce Protocol
 *
 * A complete server-side implementation of strategy 2c from the TDSC paper.
 * This serves as the measured counterpart to strategy 3b (Zairn-ZKP).
 *
 * Architecture:
 *   - POST /challenge/:dropId  → generate per-request nonce, store mapping
 *   - POST /verify             → look up nonce, validate mapping, verify Groth16
 *   - CRON cleanup             → purge expired nonce mappings
 *
 * DB schema:
 *   nonce_mappings (
 *     nonce_id    TEXT PRIMARY KEY,
 *     drop_id     TEXT NOT NULL,
 *     user_id     TEXT NOT NULL,
 *     created_at  TIMESTAMPTZ DEFAULT now(),
 *     expires_at  TIMESTAMPTZ NOT NULL,
 *     used        BOOLEAN DEFAULT false
 *   )
 *
 * Failure modes:
 *   F1: Nonce reuse — same nonce used twice (mitigated by `used` flag + unique constraint)
 *   F2: Stale mapping — nonce expired before proof submitted (mitigated by expires_at check)
 *   F3: Race condition — concurrent verify on same nonce (mitigated by atomic UPDATE...RETURNING)
 *   F4: DB consistency — nonce_mappings out of sync with drops table (orphan cleanup needed)
 *   F5: State bloat — O(k·U) rows for k drops × U users (mitigated by CRON cleanup)
 *
 * Paper section: §VII-E — Implementation complexity comparison
 */

import { createHash, randomBytes } from 'node:crypto';

// ─── Simulated Database ──────────────────────────────────────────

/**
 * In-memory DB simulation with realistic async delays.
 * In production this would be Supabase/Postgres.
 */
export class NonceMappingStore {
  constructor(dbLatencyMs = 5) {
    /** @type {Map<string, {nonce_id: string, drop_id: string, user_id: string, created_at: number, expires_at: number, used: boolean}>} */
    this.mappings = new Map();
    this.dbLatencyMs = dbLatencyMs;
    // Counters for measurement
    this.insertCount = 0;
    this.lookupCount = 0;
    this.updateCount = 0;
    this.cleanupCount = 0;
  }

  async _delay() {
    return new Promise(r => setTimeout(r, this.dbLatencyMs));
  }

  /**
   * INSERT nonce mapping.
   * SQL: INSERT INTO nonce_mappings (nonce_id, drop_id, user_id, challenge_digest, expires_at)
   *      VALUES ($1,$2,$3,$4,$5)
   */
  async insert(nonceId, dropId, userId, expiresAt, challengeDigest) {
    await this._delay();
    this.insertCount++;
    if (this.mappings.has(nonceId)) {
      throw new Error('F1: Duplicate nonce_id — nonce reuse detected');
    }
    this.mappings.set(nonceId, {
      nonce_id: nonceId,
      drop_id: dropId,
      user_id: userId,
      challengeDigest,
      created_at: Date.now(),
      expires_at: expiresAt,
      used: false,
    });
  }

  /**
   * Atomic claim: UPDATE ... SET used=true WHERE nonce_id=$1 AND used=false RETURNING *
   * Returns null if already used or not found.
   */
  async claimNonce(nonceId) {
    await this._delay();
    this.lookupCount++;
    this.updateCount++;
    const row = this.mappings.get(nonceId);
    if (!row) return null;
    if (row.used) return null; // F1: already consumed
    if (Date.now() > row.expires_at) return null; // F2: expired
    row.used = true;
    return { ...row };
  }

  /**
   * DELETE FROM nonce_mappings WHERE expires_at < now() OR used = true
   */
  async cleanup() {
    await this._delay();
    const now = Date.now();
    let removed = 0;
    for (const [key, row] of this.mappings) {
      if (row.expires_at < now || row.used) {
        this.mappings.delete(key);
        removed++;
      }
    }
    this.cleanupCount += removed;
    return removed;
  }

  get size() { return this.mappings.size; }

  get stats() {
    return {
      inserts: this.insertCount,
      lookups: this.lookupCount,
      updates: this.updateCount,
      cleanups: this.cleanupCount,
      currentSize: this.mappings.size,
    };
  }
}

// ─── Strategy 2c Server ──────────────────────────────────────────

const NONCE_TTL_MS = 30_000; // 30 seconds
const BN128_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function hashToField(value) {
  const raw = BigInt(`0x${createHash('sha256').update(value).digest('hex')}`);
  return (raw % BN128_PRIME).toString();
}

function lengthPrefixEncode(...fields) {
  return fields.map(f => `${String(f).length.toString(10).padStart(4, '0')}${f}`).join('');
}

/**
 * Strategy 2c server: per-request nonce with stored digest mapping.
 *
 * Endpoint 1: POST /challenge/:dropId
 *   → Generates unique nonce, stores {nonce → dropId, userId} mapping
 *   → Returns { nonce, expiresAt }
 *
 * Endpoint 2: POST /verify
 *   → Receives { proof, publicSignals, nonceId }
 *   → Looks up mapping, validates dropId, checks freshness, verifies Groth16
 *   → Returns { verified, reason }
 */
export class Strategy2cServer {
  /**
   * @param {import('snarkjs')} snarkjs
   * @param {object} vkey - Groth16 verification key
   * @param {number} dbLatencyMs - simulated DB latency per operation
   */
  constructor(snarkjs, vkey, dbLatencyMs = 5) {
    this.snarkjs = snarkjs;
    this.vkey = vkey;
    this.store = new NonceMappingStore(dbLatencyMs);
    this.challengeCount = 0;
    this.verifyCount = 0;
    this.rejectReasons = [];
  }

  /**
   * POST /challenge/:dropId
   * Generate per-request nonce and store mapping.
   *
   * LOC in production: ~25 (endpoint handler + validation + DB insert + error handling)
   */
  async issueChallenge(dropId, userId) {
    this.challengeCount++;
    const nonceId = randomBytes(32).toString('hex');
    const challengeDigest = hashToField(nonceId);
    const expiresAt = Date.now() + NONCE_TTL_MS;

    await this.store.insert(nonceId, dropId, userId, expiresAt, challengeDigest);

    return {
      nonceId,
      // The nonce the client will use as challengeDigest in the proof
      challengeDigest,
      expiresAt,
    };
  }

  /**
   * POST /verify — NAIVE variant (missing challengeDigest check)
   * Look up nonce mapping, validate drop binding, verify Groth16.
   * Does NOT check that publicSignals[7] matches the issued challengeDigest.
   *
   * This is a plausible implementation: the developer trusts that the nonce
   * mapping is sufficient for binding. But it leaves a gap — proofs generated
   * with a different challengeDigest still pass if Groth16 is valid.
   */
  async verifyProofNaive(proof, publicSignals, nonceId, expectedDropParams) {
    this.verifyCount++;

    // Step 1: Atomic nonce claim (DB operation)
    const mapping = await this.store.claimNonce(nonceId);
    if (!mapping) {
      const reason = 'Nonce not found, already used, or expired';
      this.rejectReasons.push(reason);
      return { verified: false, reason };
    }

    // Step 2: Validate drop binding (server-side, NOT in proof)
    if (mapping.drop_id !== expectedDropParams.dropId) {
      const reason = 'F4: Nonce was issued for a different drop';
      this.rejectReasons.push(reason);
      return { verified: false, reason };
    }

    // Step 3: Check geo signals match expected (signals [0..4])
    if (publicSignals[0] !== '1') {
      this.rejectReasons.push('Invalid proof (valid flag != 1)');
      return { verified: false, reason: 'Invalid proof' };
    }

    // NOTE: No check on publicSignals[7] vs mapping.challengeDigest
    // This is the gap that allows cross-drop transfer

    // Step 4: Verify Groth16 proof cryptographically
    try {
      const valid = await this.snarkjs.groth16.verify(this.vkey, publicSignals, proof);
      if (!valid) {
        this.rejectReasons.push('Groth16 verification failed');
        return { verified: false, reason: 'Groth16 verification failed' };
      }
    } catch (e) {
      this.rejectReasons.push(`Groth16 error: ${e.message}`);
      return { verified: false, reason: `Groth16 error: ${e.message}` };
    }

    return { verified: true, reason: null };
  }

  /**
   * POST /verify — HARDENED variant (with challengeDigest check)
   * Adds a check that publicSignals[7] matches the challengeDigest stored
   * in the nonce mapping. This closes the cross-drop transfer gap but
   * adds another server-side invariant that must be maintained correctly.
   *
   * LOC in production: ~55 (vs ~50 for naive — one more check + stored field)
   */
  async verifyProof(proof, publicSignals, nonceId, expectedDropParams) {
    this.verifyCount++;

    // Step 1: Atomic nonce claim (DB operation)
    const mapping = await this.store.claimNonce(nonceId);
    if (!mapping) {
      const reason = 'Nonce not found, already used, or expired';
      this.rejectReasons.push(reason);
      return { verified: false, reason };
    }

    // Step 2: Validate drop binding via DB mapping
    if (mapping.drop_id !== expectedDropParams.dropId) {
      const reason = 'F4: Nonce was issued for a different drop';
      this.rejectReasons.push(reason);
      return { verified: false, reason };
    }

    // Step 3: Check geo signals
    if (publicSignals[0] !== '1') {
      this.rejectReasons.push('Invalid proof (valid flag != 1)');
      return { verified: false, reason: 'Invalid proof' };
    }

    // Step 4: Check challengeDigest matches issued nonce (HARDENED)
    // Without this check, an attacker can reuse proofs across drops
    if (mapping.challengeDigest && publicSignals[7] !== mapping.challengeDigest) {
      const reason = 'F6: Challenge digest in proof does not match issued nonce';
      this.rejectReasons.push(reason);
      return { verified: false, reason };
    }

    // Step 5: Verify Groth16 proof cryptographically
    try {
      const valid = await this.snarkjs.groth16.verify(this.vkey, publicSignals, proof);
      if (!valid) {
        this.rejectReasons.push('Groth16 verification failed');
        return { verified: false, reason: 'Groth16 verification failed' };
      }
    } catch (e) {
      this.rejectReasons.push(`Groth16 error: ${e.message}`);
      return { verified: false, reason: `Groth16 error: ${e.message}` };
    }

    return { verified: true, reason: null };
  }

  get stats() {
    return {
      challenges: this.challengeCount,
      verifications: this.verifyCount,
      rejections: this.rejectReasons.length,
      rejectReasons: this.rejectReasons,
      db: this.store.stats,
    };
  }
}

// ─── Strategy 3b Server (Zairn-ZKP) ─────────────────────────────

/**
 * Strategy 3b server: epoch-derived nonce with in-proof context binding.
 *
 * Single endpoint: POST /verify
 *   → Receives { proof, publicSignals }
 *   → Recomputes expected contextDigest from (dropId, policyVersion, epoch)
 *   → Checks all 8 public signals including C, epoch, challengeDigest
 *   → Verifies Groth16
 *   → Returns { verified, reason }
 *
 * No additional DB table. No per-request state.
 */
export class Strategy3bServer {
  /**
   * @param {import('snarkjs')} snarkjs
   * @param {object} vkey - Groth16 verification key
   */
  constructor(snarkjs, vkey) {
    this.snarkjs = snarkjs;
    this.vkey = vkey;
    this.verifyCount = 0;
    this.rejectReasons = [];
    // Epoch nonce: computed once per epoch, reused for all drops
    this.currentEpoch = null;
    this.currentNonce = null;
  }

  /**
   * GET /epoch-nonce (or inlined in client SDK)
   * Returns the current epoch nonce. Same value for all drops within the epoch.
   *
   * LOC in production: ~5
   */
  getEpochNonce(epoch, userId) {
    if (this.currentEpoch !== epoch) {
      this.currentEpoch = epoch;
      this.currentNonce = hashToField(`${userId}:epoch${epoch}`);
    }
    return {
      epoch: String(epoch),
      challengeDigest: this.currentNonce,
    };
  }

  /**
   * POST /verify
   * Verify proof with in-proof context binding.
   *
   * LOC in production: ~20 (endpoint handler + digest recomputation + signal check + Groth16)
   */
  async verifyProof(proof, publicSignals, dropParams) {
    this.verifyCount++;
    const ps = publicSignals;

    // Step 1: Check valid flag
    if (ps[0] !== '1') {
      this.rejectReasons.push('Invalid proof (valid flag != 1)');
      return { verified: false, reason: 'Invalid proof' };
    }

    // Step 2: Recompute expected context digest (pure computation, no DB)
    const expectedC = hashToField(
      lengthPrefixEncode(dropParams.dropId, dropParams.policyVersion, String(dropParams.epoch))
    );

    // Step 3: Check ALL 8 public signals including context binding
    if (ps[5] !== expectedC) {
      this.rejectReasons.push('Context digest mismatch (cross-drop transfer blocked)');
      return { verified: false, reason: 'Context digest mismatch' };
    }
    if (ps[6] !== dropParams.epoch) {
      this.rejectReasons.push('Epoch mismatch');
      return { verified: false, reason: 'Epoch mismatch' };
    }
    if (ps[7] !== dropParams.challengeDigest) {
      this.rejectReasons.push('Challenge digest mismatch');
      return { verified: false, reason: 'Challenge digest mismatch' };
    }

    // Step 4: Verify Groth16 proof
    try {
      const valid = await this.snarkjs.groth16.verify(this.vkey, publicSignals, proof);
      if (!valid) {
        this.rejectReasons.push('Groth16 verification failed');
        return { verified: false, reason: 'Groth16 verification failed' };
      }
    } catch (e) {
      this.rejectReasons.push(`Groth16 error: ${e.message}`);
      return { verified: false, reason: `Groth16 error: ${e.message}` };
    }

    return { verified: true, reason: null };
  }

  get stats() {
    return {
      verifications: this.verifyCount,
      rejections: this.rejectReasons.length,
      rejectReasons: this.rejectReasons,
    };
  }
}

// ─── LOC and Complexity Accounting ───────────────────────────────

export const complexityComparison = {
  '2c': {
    serverEndpoints: 2,        // POST /challenge/:dropId, POST /verify
    dbTables: 1,               // nonce_mappings
    dbOperationsPerVerify: 2,  // claim (SELECT+UPDATE) + initial INSERT
    serverLOC: {
      challengeEndpoint: 25,   // handler + validation + DB insert + error handling
      verifyEndpoint: 50,      // handler + nonce lookup + mapping check + Groth16 + audit
      dbMigration: 15,         // CREATE TABLE + indexes + RLS
      cronCleanup: 20,         // scheduled cleanup of expired/used nonces
      total: 110,
    },
    failureModes: [
      'F1: Nonce reuse (duplicate nonce_id)',
      'F2: Stale mapping (nonce expired before proof submitted)',
      'F3: Race condition (concurrent verify on same nonce)',
      'F4: DB consistency (nonce-to-drop mapping mismatch)',
      'F5: State bloat (O(k·U) rows requiring periodic cleanup)',
      'F6: Missing challenge-digest check (cross-drop transfer if omitted)',
    ],
    statePerRequest: 'O(k·U)',   // k drops × U concurrent users
    challengeRoundTrips: 'k',     // one RT per drop
    requiresCleanupCron: true,
  },
  '3b': {
    serverEndpoints: 1,        // POST /verify (epoch nonce is derivable)
    dbTables: 0,               // no additional tables
    dbOperationsPerVerify: 0,  // pure computation
    serverLOC: {
      verifyEndpoint: 20,      // handler + digest recomputation + signal check + Groth16
      total: 20,
    },
    failureModes: [
      'F1: Epoch staleness (client submits proof after epoch rotation)',
    ],
    statePerRequest: 'O(1)',    // epoch nonce is stateless
    challengeRoundTrips: '1',   // single epoch nonce request
    requiresCleanupCron: false,
  },
};
