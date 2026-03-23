/**
 * Search-Bound Proximity Proofs (SBPP)
 *
 * Protocol that cryptographically binds encrypted geographic search to
 * zero-knowledge proximity verification. A search session nonce is
 * embedded in both the search phase and the ZKP's public inputs,
 * ensuring that a proof is valid only for drops discovered in the
 * same session.
 *
 * Protocol flow:
 *   1. Client requests a search session → Server returns (sessionId, nonce, expiresAt)
 *   2. Client generates encrypted search tokens (GridSE-style HMAC)
 *   3. Server matches opaque tokens → candidate drops
 *   4. Client generates ZKP where challengeDigest = H(LP(dropId, pv, epoch, nonce))
 *   5. Server verifies proof AND checks nonce matches the active session
 *
 * Security properties:
 *   - Search-proof binding: proof only valid with the session's nonce
 *   - Cross-session isolation: proof from session S1 rejected in S2
 *   - Temporal binding: expired sessions reject all proofs
 */

import {
  generateSearchTokens,
  generateIndexTokens,
  matchTokens,
  selectPrecisionForRadius,
} from './encrypted-search.js';
import type {
  EncryptedSearchConfig,
  SearchTokenSet,
  LocationIndexTokens,
  EncryptedSearchMatch,
} from './encrypted-search.js';
import { lengthPrefixEncode } from './zkp.js';

// =====================
// Types
// =====================

/** A search session with server-issued nonce */
export interface SbppSession {
  /** Unique session identifier */
  sessionId: string;
  /** Cryptographically random nonce (hex, 32 bytes) */
  nonce: string;
  /** When this session was created */
  createdAt: number;
  /** When this session expires (Unix ms) */
  expiresAt: number;
  /** Digest of the result set returned by server (set after matching) */
  resultSetDigest?: string;
  /** Candidate drop IDs from the search result (set after matching) */
  candidateDropIds?: Set<string>;
}

/** Options for creating an SBPP session */
export interface SbppSessionOptions {
  /** Session TTL in milliseconds (default: 5 minutes) */
  ttlMs?: number;
}

/** Result of an SBPP search */
export interface SbppSearchResult {
  /** The session used for this search */
  session: SbppSession;
  /** Encrypted search tokens sent to server */
  searchTokens: SearchTokenSet;
  /** Matched drops from server */
  matches: EncryptedSearchMatch[];
}

/** Context for generating a session-bound ZKP */
export interface SbppProofContext {
  /** Drop ID being unlocked */
  dropId: string;
  /** Policy version */
  policyVersion: string;
  /** Epoch (e.g., daily rotation) */
  epoch: string;
  /** Session nonce from the search session */
  sessionNonce: string;
  /** Digest of the result set returned by the search (optional but recommended) */
  resultSetDigest?: string;
}

/**
 * Simple binary Merkle tree for result-set commitment.
 * Provides O(log k) membership proofs and O(1) root storage.
 */

// Hash function for Merkle nodes (using LP encoding for domain separation)
function merkleLeafHash(dropId: string): string {
  return lengthPrefixEncode('SBPP-LEAF', dropId);
}

function merkleNodeHash(left: string, right: string): string {
  return lengthPrefixEncode('SBPP-NODE', left, right);
}

export interface MerkleProof {
  leaf: string;
  path: { sibling: string; direction: 'left' | 'right' }[];
  root: string;
}

/**
 * Build a Merkle tree from candidate drop IDs.
 * Returns the root hash and allows generating membership proofs.
 */
export class MerkleResultSet {
  readonly root: string;
  readonly leaves: string[];
  private layers: string[][];

  constructor(candidateDropIds: string[]) {
    const sorted = [...candidateDropIds].sort();
    this.leaves = sorted.map(merkleLeafHash);

    // Build tree bottom-up
    this.layers = [this.leaves.slice()];
    let current = this.leaves.slice();

    while (current.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < current.length; i += 2) {
        if (i + 1 < current.length) {
          next.push(merkleNodeHash(current[i], current[i + 1]));
        } else {
          next.push(current[i]); // odd node promoted
        }
      }
      this.layers.push(next);
      current = next;
    }

    this.root = current[0] || '';
  }

  /** Generate a membership proof for a dropId */
  prove(dropId: string): MerkleProof | null {
    const leafHash = merkleLeafHash(dropId);
    let idx = this.leaves.indexOf(leafHash);
    if (idx === -1) return null;

    const path: MerkleProof['path'] = [];
    for (let layer = 0; layer < this.layers.length - 1; layer++) {
      const level = this.layers[layer];
      if (idx % 2 === 0) {
        if (idx + 1 < level.length) {
          path.push({ sibling: level[idx + 1], direction: 'right' });
        }
      } else {
        path.push({ sibling: level[idx - 1], direction: 'left' });
      }
      idx = Math.floor(idx / 2);
    }

    return { leaf: leafHash, path, root: this.root };
  }

  /** Verify a membership proof */
  static verify(proof: MerkleProof): boolean {
    let hash = proof.leaf;
    for (const step of proof.path) {
      if (step.direction === 'left') {
        hash = merkleNodeHash(step.sibling, hash);
      } else {
        hash = merkleNodeHash(hash, step.sibling);
      }
    }
    return hash === proof.root;
  }

  get size(): number {
    return this.leaves.length;
  }
}

/**
 * Compute a canonical digest of the search result set.
 *
 * The result set is sorted by dropId to ensure determinism regardless
 * of server-side ordering. The digest commits the protocol version,
 * session ID, search parameters, and the exact set of candidate drops.
 *
 * This binds the proof not just to the session but to the specific
 * drops returned in that session—preventing an attacker from
 * generating a proof for a drop that was not in the search results.
 */
export function computeResultSetDigest(
  sessionId: string,
  candidateDropIds: string[],
  precision: number,
): string {
  const sorted = [...candidateDropIds].sort();
  return lengthPrefixEncode(
    SBPP_DOMAIN_SEPARATOR,
    sessionId,
    String(precision),
    ...sorted,
  );
}

// =====================
// Session management
// =====================

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Generate a cryptographically random hex string.
 * Uses Web Crypto API (available in browsers and Node.js 18+).
 */
function generateRandomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a new SBPP search session.
 *
 * In a real deployment, this runs on the server. The nonce is
 * cryptographically random and stored server-side with a TTL.
 */
export function createSession(options?: SbppSessionOptions): SbppSession {
  const ttl = options?.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();

  return {
    sessionId: generateRandomHex(16),
    nonce: generateRandomHex(32),
    createdAt: now,
    expiresAt: now + ttl,
  };
}

/**
 * Check whether a session is still valid (not expired).
 */
export function isSessionValid(session: SbppSession, now?: number): boolean {
  return (now ?? Date.now()) < session.expiresAt;
}

// =====================
// Server-side session store (in-memory for evaluation)
// =====================

/** Simple in-memory session store for evaluation and testing */
export class SbppSessionStore {
  private sessions = new Map<string, SbppSession>();

  /** Issue a new session */
  issue(options?: SbppSessionOptions): SbppSession {
    const session = createSession(options);
    this.sessions.set(session.sessionId, session);
    return session;
  }

  /** Validate a session by ID and nonce */
  validate(sessionId: string, nonce: string, now?: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (!isSessionValid(session, now)) {
      this.sessions.delete(sessionId);
      return false;
    }
    return session.nonce === nonce;
  }

  /** Consume (invalidate) a session after successful proof verification */
  consume(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  /** Atomic validate-and-consume: prevents TOCTOU race in concurrent environments */
  consumeIfValid(sessionId: string, nonce: string, now?: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (!isSessionValid(session, now)) {
      this.sessions.delete(sessionId);
      return false;
    }
    if (session.nonce !== nonce) return false;
    this.sessions.delete(sessionId);
    return true;
  }

  /** Get session count (for testing) */
  get size(): number {
    return this.sessions.size;
  }

  /** Set the result-set digest for a session (called after token matching) */
  setResultDigest(sessionId: string, digest: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.resultSetDigest = digest;
    return true;
  }

  /** Get the result-set digest for a session */
  getResultDigest(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.resultSetDigest;
  }

  /** Set the candidate drop set for a session (called after matching) */
  setCandidateSet(sessionId: string, dropIds: Set<string>): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.candidateDropIds = dropIds;
    return true;
  }

  /** Check if a drop was in the session's candidate set */
  isCandidateDrop(sessionId: string, dropId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.candidateDropIds?.has(dropId) ?? false;
  }

  /** Purge expired sessions */
  purgeExpired(now?: number): number {
    const t = now ?? Date.now();
    let purged = 0;
    for (const [id, session] of this.sessions) {
      if (t >= session.expiresAt) {
        this.sessions.delete(id);
        purged++;
      }
    }
    return purged;
  }
}

// =====================
// Offline audit log
// =====================

/** A single audit record for offline verification */
export interface SbppAuditRecord {
  sessionId: string;
  dropId: string;
  challengeDigest: string;
  merkleRoot: string;
  merkleProof: MerkleProof;
  timestamp: number;
  verified: boolean;
}

/**
 * Audit log for offline transcript verification.
 *
 * Full SBPP enables transcript-level authorization: an auditor
 * can verify that a proof was generated for a drop in the
 * authorized result set without access to server-side session state.
 */
export class SbppAuditLog {
  private records: SbppAuditRecord[] = [];

  /** Record a successful verification */
  record(entry: SbppAuditRecord): void {
    this.records.push(entry);
  }

  /**
   * Offline audit: verify all records using only transcript data.
   * Returns { valid, invalid, details }.
   * This works WITHOUT access to server-side session state.
   */
  audit(): { valid: number; invalid: number; details: { index: number; dropId: string; ok: boolean }[] } {
    const details: { index: number; dropId: string; ok: boolean }[] = [];
    let valid = 0;
    let invalid = 0;

    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i];
      // Verify Merkle proof (transcript-only, no server state needed)
      const merkleOk = MerkleResultSet.verify(r.merkleProof);
      // Verify the proof's Merkle root matches the logged root
      const rootOk = r.merkleProof.root === r.merkleRoot;
      const ok = merkleOk && rootOk;
      details.push({ index: i, dropId: r.dropId, ok });
      if (ok) valid++; else invalid++;
    }

    return { valid, invalid, details };
  }

  get length(): number {
    return this.records.length;
  }

  getRecords(): readonly SbppAuditRecord[] {
    return this.records;
  }
}

// =====================
// Search-proof binding
// =====================

/**
 * Protocol version domain separator.
 * Prevents confusion between SBPP-bound and non-SBPP challenge digests.
 * A non-SBPP digest uses LP(dropId, pv, epoch) without this prefix,
 * so the two are structurally distinct even if the same nonce appears.
 */
export const SBPP_DOMAIN_SEPARATOR = 'SBPP-v1';

/**
 * Build the SBPP challenge digest that binds search session to ZKP proof.
 *
 * This extends the TDSC paper's context binding by including a
 * protocol domain separator and the search session nonce:
 *
 *   challengeDigest = LP("SBPP-v1", dropId, pv, epoch, nonce [, resultSetDigest])
 *
 * The domain separator ensures that an SBPP digest can never collide
 * with a non-SBPP digest, preventing downgrade/confusion attacks.
 *
 * When resultSetDigest is provided, the proof is bound not only to the
 * session but to the specific set of candidate drops returned in that
 * session. This prevents an attacker from proving proximity to a drop
 * that was not in the search results.
 *
 * The resulting digest is used as pub[7] in the Groth16 proof.
 */
export function buildSbppChallengeDigest(ctx: SbppProofContext): string {
  const fields = [
    SBPP_DOMAIN_SEPARATOR,
    ctx.dropId,
    ctx.policyVersion,
    ctx.epoch,
    ctx.sessionNonce,
  ];
  if (ctx.resultSetDigest) {
    fields.push(ctx.resultSetDigest);
  }
  return lengthPrefixEncode(...fields);
}

/**
 * Verify that a challengeDigest matches the expected SBPP binding.
 *
 * Server-side: recompute the expected digest from known parameters
 * (dropId, pv, epoch from the drop record; nonce from the session)
 * and compare against the proof's public signal.
 */
export function verifySbppBinding(
  proofChallengeDigest: string,
  expectedCtx: SbppProofContext,
): boolean {
  const expected = buildSbppChallengeDigest(expectedCtx);
  return proofChallengeDigest === expected;
}

// =====================
// End-to-end protocol helpers
// =====================

/**
 * Client-side: perform an SBPP search.
 *
 * Generates encrypted search tokens and returns them alongside
 * the session for later use in proof generation.
 */
export async function sbppSearch(
  lat: number,
  lon: number,
  radiusMeters: number,
  session: SbppSession,
  searchConfig: EncryptedSearchConfig,
): Promise<{ session: SbppSession; searchTokens: SearchTokenSet }> {
  if (!isSessionValid(session)) {
    throw new Error('SBPP session expired');
  }

  const searchTokens = await generateSearchTokens(
    lat,
    lon,
    radiusMeters,
    searchConfig,
  );

  return { session, searchTokens };
}

/**
 * Server-side: match search tokens against indexed drops.
 *
 * This is a thin wrapper around matchTokens that also validates
 * the session.
 */
export function sbppMatch(
  searchTokens: SearchTokenSet,
  indexedDrops: { dropId: string; tokens: LocationIndexTokens }[],
  sessionStore: SbppSessionStore,
  sessionId: string,
  nonce: string,
): EncryptedSearchMatch[] {
  if (!sessionStore.validate(sessionId, nonce)) {
    throw new Error('Invalid or expired SBPP session');
  }

  const matches = matchTokens(searchTokens, indexedDrops);
  const matchedIds = matches.map(m => m.dropId);

  // Store result-set digest AND candidate set for later verification.
  const resultDigest = computeResultSetDigest(
    sessionId, matchedIds, searchTokens.precision,
  );
  sessionStore.setResultDigest(sessionId, resultDigest);
  sessionStore.setCandidateSet(sessionId, new Set(matchedIds));

  return matches;
}

/**
 * Server-side: verify a session-bound proof.
 *
 * Checks that:
 * 1. The session is valid
 * 2. The proof's challengeDigest matches the expected binding
 * 3. (Groth16 verification is done separately via verifyProximityProof)
 *
 * On success, the session is consumed (one proof per session).
 */
export function sbppVerifyBinding(
  sessionStore: SbppSessionStore,
  sessionId: string,
  nonce: string,
  proofChallengeDigest: string,
  dropId: string,
  policyVersion: string,
  epoch: string,
): { valid: boolean; reason?: string } {
  // 1. Validate session
  if (!sessionStore.validate(sessionId, nonce)) {
    return { valid: false, reason: 'invalid_session' };
  }

  // 2. Build expected context (with result-set digest if available)
  const resultSetDigest = sessionStore.getResultDigest(sessionId);
  const expectedCtx: SbppProofContext = {
    dropId,
    policyVersion,
    epoch,
    sessionNonce: nonce,
    ...(resultSetDigest && { resultSetDigest }),
  };

  // 3. Verify binding
  if (!verifySbppBinding(proofChallengeDigest, expectedCtx)) {
    return { valid: false, reason: 'binding_mismatch' };
  }

  // 4. Verify dropId was in the result set (defense-in-depth)
  if (resultSetDigest && !sessionStore.isCandidateDrop(sessionId, dropId)) {
    return { valid: false, reason: 'drop_not_in_result_set' };
  }

  // 5. Consume session atomically (one proof per session)
  // Note: In-memory store is single-threaded (Node.js), so TOCTOU is not
  // exploitable here. For production DB-backed stores, use
  // consumeIfValid() or a DB transaction with DELETE ... RETURNING.
  sessionStore.consume(sessionId);

  return { valid: true };
}

// =====================
// Inverted index for O(1) token matching
// =====================

/**
 * Server-side inverted index: maps token → Set<dropId>.
 *
 * Replaces linear-scan matchTokens() with O(|searchTokens|) lookups.
 * In production, this would be backed by a database index
 * (CREATE INDEX ON drop_index_tokens(token)).
 */
export class TokenInvertedIndex {
  private index = new Map<string, Set<string>>();

  /** Add a drop's tokens to the index */
  addDrop(dropId: string, tokens: LocationIndexTokens): void {
    for (const { token } of tokens.tokens) {
      let set = this.index.get(token);
      if (!set) {
        set = new Set();
        this.index.set(token, set);
      }
      set.add(dropId);
    }
  }

  /** Remove a drop from the index */
  removeDrop(dropId: string, tokens: LocationIndexTokens): void {
    for (const { token } of tokens.tokens) {
      const set = this.index.get(token);
      if (set) {
        set.delete(dropId);
        if (set.size === 0) this.index.delete(token);
      }
    }
  }

  /**
   * Match search tokens against the index.
   * Returns deduplicated drop IDs that have at least one matching token.
   */
  match(searchTokens: SearchTokenSet): EncryptedSearchMatch[] {
    const matched = new Map<string, number>(); // dropId → matched precision
    for (const token of searchTokens.tokens) {
      const drops = this.index.get(token);
      if (drops) {
        for (const dropId of drops) {
          if (!matched.has(dropId)) {
            matched.set(dropId, searchTokens.precision);
          }
        }
      }
    }
    return Array.from(matched.entries()).map(([dropId, matchedPrecision]) => ({
      dropId,
      matchedPrecision,
    }));
  }

  /** Number of unique tokens in the index */
  get size(): number {
    return this.index.size;
  }

  /** Number of indexed drops (approximate, via unique dropIds) */
  get dropCount(): number {
    const drops = new Set<string>();
    for (const set of this.index.values()) {
      for (const id of set) drops.add(id);
    }
    return drops.size;
  }
}

// =====================
// Re-exports for convenience
// =====================

export {
  generateIndexTokens,
  generateSearchTokens,
  matchTokens,
  selectPrecisionForRadius,
};

export type {
  EncryptedSearchConfig,
  SearchTokenSet,
  LocationIndexTokens,
  EncryptedSearchMatch,
};
