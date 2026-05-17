/**
 * SBPP vs Naive Composition: Attack Success Rate Comparison
 *
 * Compares nine protocol variants against five attack classes:
 *   A1: Cross-session proof reuse
 *   A2: Search-verify decorrelation (timing correlation)
 *   A3: Proof transfer between drops
 *   A4: Result-set escape (proof for drop NOT in results)
 *   A4b_audit: Transcript-level audit (can auditor without server secret verify?)
 *
 * Protocol variants:
 *   V1: Plaintext search + ZKP (no encrypted search, no session binding)
 *   V2: GridSE-only (encrypted search, no session binding in proof)
 *   V3: App-layer nonce (server checks nonce separately, not in proof)
 *   V4: SBPP (nonce embedded in proof public input)
 *   V5: Signed capability token (server signs sidecar, not in proof)
 *   V6: Per-drop signed permit (no ZKP — server permit only)
 *   V7: MAC-bound result authorization (server MAC over result set)
 *   V8: Internalized-token (server-signed token committed inside proof public input
 *       — represents the circuit-modification baseline; satisfies SAP at the cost
 *       of trusted-setup re-running and undifferentiated audit failures)
 *   V9: Post-proof signed receipt (server signs Sig_S(s, d, H(pi)) at proof
 *       acceptance — escapes the separation theorem via W2-violation; closest
 *       competitor to SBPP. Trust differentiator: V9 requires the server to be
 *       online and willing to sign at acceptance time, and audit integrity
 *       depends on server-side log finalisation. SBPP fixes the binding
 *       before the proof is built, and the audit record is client-finalisable.)
 *
 * The key question: which attacks succeed against which variants?
 */

import { createSession, SbppSessionStore, buildSbppChallengeDigest, verifySbppBinding, sbppVerifyBinding, computeResultSetDigest } from '../dist/sbpp.js';
import { generateSearchTokens, generateIndexTokens, matchTokens } from '../dist/encrypted-search.js';
import { lengthPrefixEncode } from '../dist/zkp.js';
import { createHash } from 'node:crypto';

const config = { searchKey: 'naive-comparison-key', precisionLevels: [4, 5, 6] };
const TOKYO = { lat: 35.6893, lon: 139.7762 };
const N = 1000;

// ═══════════════════════════════════════
// Protocol variant implementations
// ═══════════════════════════════════════

/**
 * V1: Plaintext + ZKP
 * - Search: server sees geohash
 * - Proof: contextDigest = H(LP(dropId, pv, epoch))
 * - No session binding at all
 */
function v1_verify(proofDigest, dropId, pv, epoch) {
  const expected = lengthPrefixEncode(dropId, pv, epoch);
  return proofDigest === expected;
}

/**
 * V2: GridSE + ZKP
 * - Search: encrypted tokens (server can't see geohash)
 * - Proof: contextDigest = H(LP(dropId, pv, epoch))
 * - No session binding in proof
 */
function v2_verify(proofDigest, dropId, pv, epoch) {
  // Same as V1 at the proof level — no session binding
  return v1_verify(proofDigest, dropId, pv, epoch);
}

/**
 * V3: App-layer nonce (server-side check, not in proof)
 * - Search: encrypted tokens + server-issued nonce
 * - Proof: contextDigest = H(LP(dropId, pv, epoch)) — nonce NOT in digest
 * - Server checks nonce separately in application layer
 */
class V3Server {
  constructor() {
    this.sessions = new Map();
  }
  issueSession() {
    const id = Math.random().toString(36).slice(2);
    const nonce = createHash('sha256').update(Math.random().toString()).digest('hex');
    this.sessions.set(id, { nonce, used: false });
    return { sessionId: id, nonce };
  }
  verify(sessionId, nonce, proofDigest, dropId, pv, epoch) {
    const session = this.sessions.get(sessionId);
    if (!session || session.nonce !== nonce || session.used) return false;
    // Check proof digest (no nonce in digest)
    const expected = lengthPrefixEncode(dropId, pv, epoch);
    if (proofDigest !== expected) return false;
    session.used = true;
    return true;
  }
}

/**
 * V5: Signed Capability Token
 * - Server signs (sessionId, dropId, pv, epoch, expiry) as a capability token
 * - Client presents this signed token alongside the proof
 * - Server verifies the signature
 * - The proof itself does NOT contain the capability — it's a separate sidecar object
 */
class V5Server {
  constructor() {
    this.signingKey = crypto.randomUUID();
    this.sessions = new Map();
    this.consumedSessions = new Set();
    this.resultSets = new Map();
  }
  issueSession() {
    const id = Math.random().toString(36).slice(2);
    const nonce = createHash('sha256').update(Math.random().toString()).digest('hex');
    this.sessions.set(id, { nonce, used: false });
    return { sessionId: id, nonce };
  }
  setResultSet(sessionId, dropIds) {
    this.resultSets.set(sessionId, new Set(dropIds));
  }
  signCapability(sessionId, dropId, pv, epoch) {
    const msg = `${sessionId}:${dropId}:${pv}:${epoch}`;
    return createHash('sha256').update(this.signingKey + msg).digest('hex');
  }
  verify(sessionId, nonce, proofDigest, dropId, pv, epoch, capability) {
    const session = this.sessions.get(sessionId);
    if (!session || session.nonce !== nonce || session.used) return false;
    // Check capability signature
    const expectedCap = this.signCapability(sessionId, dropId, pv, epoch);
    if (capability !== expectedCap) return false;
    // Check result-set membership if result set was registered
    const rs = this.resultSets.get(sessionId);
    if (rs && !rs.has(dropId)) return false;
    // Check proof digest (NO nonce in digest — same as V1)
    const expected = lengthPrefixEncode(dropId, pv, epoch);
    if (proofDigest !== expected) return false;
    session.used = true;
    return true;
  }
}

/**
 * V6: Per-Drop Signed Permit
 * - Server issues a signed permit for drop D after search
 * - No ZKP verification — just checks the permit
 * - This bypasses proximity proof entirely
 */
class V6Server {
  constructor() {
    this.signingKey = crypto.randomUUID();
    this.sessions = new Map();
  }
  issueSession() {
    const id = Math.random().toString(36).slice(2);
    this.sessions.set(id, { used: false, permits: new Set() });
    return { sessionId: id };
  }
  issuePermit(sessionId, dropId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const msg = `${sessionId}:${dropId}`;
    const permit = createHash('sha256').update(this.signingKey + msg).digest('hex');
    session.permits.add(dropId);
    return permit;
  }
  verify(sessionId, dropId, permit) {
    const session = this.sessions.get(sessionId);
    if (!session || session.used) return false;
    const expectedPermit = createHash('sha256').update(this.signingKey + `${sessionId}:${dropId}`).digest('hex');
    if (permit !== expectedPermit) return false;
    session.used = true;
    return true;
  }
}

/**
 * V7: MAC-Bound Result Authorization
 * - Server computes MAC_k(sort(D1,...,Dk)) over the result set
 * - Client includes the MAC with the proof
 * - Server verifies MAC and proof separately
 * - MAC key is server-side secret — auditor cannot verify
 */
class V7Server {
  constructor() {
    this.macKey = crypto.randomUUID();
    this.sessions = new Map();
  }
  issueSession() {
    const id = Math.random().toString(36).slice(2);
    const nonce = createHash('sha256').update(Math.random().toString()).digest('hex');
    this.sessions.set(id, { nonce, used: false, resultMac: null, resultSet: null });
    return { sessionId: id, nonce };
  }
  computeResultMac(sessionId, dropIds) {
    const sorted = [...dropIds].sort();
    const msg = `${sessionId}:${sorted.join(',')}`;
    const mac = createHash('sha256').update(this.macKey + msg).digest('hex');
    const session = this.sessions.get(sessionId);
    if (session) {
      session.resultMac = mac;
      session.resultSet = new Set(dropIds);
    }
    return mac;
  }
  verify(sessionId, nonce, proofDigest, dropId, pv, epoch, resultMac) {
    const session = this.sessions.get(sessionId);
    if (!session || session.nonce !== nonce || session.used) return false;
    // Check result MAC matches
    if (session.resultMac !== resultMac) return false;
    // Check drop is in result set
    if (session.resultSet && !session.resultSet.has(dropId)) return false;
    // Check proof digest (NO nonce in digest — same as V1)
    const expected = lengthPrefixEncode(dropId, pv, epoch);
    if (proofDigest !== expected) return false;
    session.used = true;
    return true;
  }
}

/**
 * V4: SBPP (nonce IN proof digest)
 * - Search: encrypted tokens + server-issued nonce
 * - Proof: contextDigest = H(LP(dropId, pv, epoch, nonce))
 * - Server verifies nonce is embedded in the proof's public input
 */
// Uses SbppSessionStore + sbppVerifyBinding directly

/**
 * V8: Internalized-token (circuit modification baseline)
 * - Search: server signs an authorization token that bundles
 *           (sessionId, resultSet, params) into a single hash.
 * - Proof: contextDigest = H(LP(dropId, pv, epoch, tokenHash))
 *           — the token hash is committed INSIDE the proof's public input.
 * - Verification: server / auditor recomputes tokenHash from the signed
 *           token and compares with proofDigest.
 *
 * Comparison with V4 (SBPP):
 *   V4 decomposes pub[7] into (nonce, merkleRoot, ctx) so an auditor can
 *   distinguish which property failed (P1 / P2 / P3).
 *   V8 bundles everything into a single opaque tokenHash, so audit
 *   verification returns "hash mismatch" without finer granularity.
 *
 * In a real deployment, V8 would require modifying the ZK circuit to
 * recompute tokenHash from individual fields and to enforce equality
 * with a circuit-level public input. This costs:
 *   - Trusted-setup re-running
 *   - +200--400 R1CS constraints
 *   - Re-issued verifying keys
 *
 * The simulation here matches V8's *security* (which is equivalent to V4
 * up to differential audit semantics) without modifying the actual
 * Groth16 circuit.
 */
class V8Server {
  constructor() {
    this.signingKey = crypto.randomUUID();
    this.sessions = new Map();   // sessionId -> { tokenHash, resultSet, used }
  }
  issueSession() {
    const id = Math.random().toString(36).slice(2);
    this.sessions.set(id, { tokenHash: null, resultSet: null, used: false });
    return { sessionId: id };
  }
  signToken(sessionId, dropIds, pv, epoch) {
    // Bundle session + result set + parameters into one opaque hash
    const sortedIds = [...dropIds].sort().join(',');
    const msg = `${sessionId}:${sortedIds}:${pv}:${epoch}`;
    const tokenHash = createHash('sha256').update(this.signingKey + msg).digest('hex');
    const session = this.sessions.get(sessionId);
    if (session) {
      session.tokenHash = tokenHash;
      session.resultSet = new Set(dropIds);
    }
    return tokenHash;
  }
  // Build the proof digest with tokenHash internalized into pub[7]
  buildProofDigest(dropId, pv, epoch, tokenHash) {
    return lengthPrefixEncode(dropId, pv, epoch, tokenHash);
  }
  verify(sessionId, proofDigest, dropId, pv, epoch) {
    const session = this.sessions.get(sessionId);
    if (!session || session.used || !session.tokenHash) return false;
    if (session.resultSet && !session.resultSet.has(dropId)) return false;
    // Recompute expected digest from logged tokenHash
    const expected = this.buildProofDigest(dropId, pv, epoch, session.tokenHash);
    if (proofDigest !== expected) return false;
    session.used = true;
    return true;
  }
  // Auditor's verification: same as verify, but using only the logged token
  // (the auditor reads tokenHash from a public log; no server secret needed)
  auditVerify(loggedTokenHash, proofDigest, dropId, pv, epoch) {
    const expected = this.buildProofDigest(dropId, pv, epoch, loggedTokenHash);
    return proofDigest === expected;
  }
}

/**
 * V9: Post-proof signed receipt (closest competitor to SBPP)
 * - Search: server issues sessionId; no per-session binding evidence is
 *   returned at this point. The result set is recorded server-side.
 * - Proof: contextDigest = H(LP(dropId, pv, epoch)) — session-INDEPENDENT.
 *   (W1) holds: the proof statement does not depend on s.
 * - At proof acceptance, the server computes
 *     receipt = Sig_S(sessionId, dropId, H(pi), timestamp)
 *   and appends the receipt to an authenticated log. (W2) FAILS because
 *   the evidence depends on pi.
 * - Audit: an offline auditor with the server's public key reads the
 *   receipt and attributes pi to receipt.sessionId.
 *
 * Trust boundary versus V4 (SBPP):
 * - V4 binds at search time inside the proof's public input. The audit
 *   record is finalisable client-side at submission; the auditor verifies
 *   offline using only the server's public key. The server need not be
 *   reachable at audit time, and no online-acceptance-path trust is
 *   required.
 * - V9 binds at proof-acceptance time. The server MUST be present and
 *   willing to sign; audit integrity additionally rests on server-side
 *   log finalisation procedures (e.g., that the log is append-only and
 *   that no post-hoc receipt rewrites occur).
 */
class V9Server {
  constructor() {
    this.signingKey = crypto.randomUUID();
    this.sessions = new Map();   // sessionId -> { resultSet }
    this.receiptLog = [];        // append-only log of signed receipts
  }
  issueSession() {
    const id = Math.random().toString(36).slice(2);
    this.sessions.set(id, { resultSet: null });
    return { sessionId: id };
  }
  setResultSet(sessionId, dropIds) {
    const s = this.sessions.get(sessionId);
    if (s) s.resultSet = new Set(dropIds);
  }
  // The proof digest is session-INDEPENDENT (W1 holds — proof-external).
  buildProofDigest(dropId, pv, epoch) {
    return lengthPrefixEncode(dropId, pv, epoch);
  }
  /**
   * At proof acceptance:
   *   1. Verify pi (here: digest equality check stands in for ZKP verify).
   *   2. Check drop membership in the session's result set.
   *   3. Sign the post-proof receipt and append to the log.
   * Returns true iff the receipt is signed and logged.
   */
  verify(sessionId, proofDigest, dropId, pv, epoch) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.resultSet && !session.resultSet.has(dropId)) return false;
    const expected = this.buildProofDigest(dropId, pv, epoch);
    if (proofDigest !== expected) return false;
    // Post-proof receipt: server signs (sessionId, dropId, H(pi), timestamp).
    // This is the W2-violation that resolves P3.
    const proofHash = createHash('sha256').update(proofDigest).digest('hex');
    const ts = Date.now();
    const receiptMsg = `${sessionId}:${dropId}:${proofHash}:${ts}`;
    const receipt = createHash('sha256').update(this.signingKey + receiptMsg).digest('hex');
    this.receiptLog.push({ sessionId, dropId, proofHash, ts, receipt });
    return true;
  }
  /**
   * Auditor's verification: with the server's public key (here, signingKey
   * as a shared verification material for the hash-based simulation), the
   * auditor reconstructs the receipt from the logged fields and confirms
   * the signature. Returns the attributed session id on success.
   */
  auditVerify(loggedReceipt) {
    const { sessionId, dropId, proofHash, ts, receipt } = loggedReceipt;
    const receiptMsg = `${sessionId}:${dropId}:${proofHash}:${ts}`;
    const expected = createHash('sha256').update(this.signingKey + receiptMsg).digest('hex');
    return receipt === expected ? sessionId : null;
  }
}

// ═══════════════════════════════════════
// Attack simulations
// ═══════════════════════════════════════

function runAttacks() {
  const results = {
    timestamp: new Date().toISOString(),
    n_trials: N,
    attacks: {},
  };

  // ─── A1: Cross-session proof reuse ───
  // Attacker generates a valid proof in session S1, then submits it in session S2.
  {
    let v1_success = 0, v2_success = 0, v3_success = 0, v4_success = 0;
    let v5_success = 0, v6_success = 0, v7_success = 0, v8_success = 0, v9_success = 0;

    for (let i = 0; i < N; i++) {
      const dropId = `drop-${i}`;
      const pv = '1';
      const epoch = '42';

      // V1: no sessions at all → proof is always reusable
      const digest_v1 = lengthPrefixEncode(dropId, pv, epoch);
      if (v1_verify(digest_v1, dropId, pv, epoch)) v1_success++;

      // V2: same as V1 at proof level
      if (v2_verify(digest_v1, dropId, pv, epoch)) v2_success++;

      // V3: app-layer nonce — attacker needs to steal session
      const v3server = new V3Server();
      const s1 = v3server.issueSession();
      const s2 = v3server.issueSession();
      // Attacker builds proof in S1 context (no nonce in digest)
      const digest_v3 = lengthPrefixEncode(dropId, pv, epoch);
      // Attacker submits proof in S2 — since digest doesn't contain nonce,
      // the proof digest still matches. But server checks session separately.
      // If attacker has S2's nonce (e.g., from intercepting the session init),
      // the app-layer check passes.
      if (v3server.verify(s2.sessionId, s2.nonce, digest_v3, dropId, pv, epoch)) {
        v3_success++;
      }

      // V4: SBPP — nonce is in the digest
      const v4store = new SbppSessionStore();
      const v4s1 = v4store.issue();
      const v4s2 = v4store.issue();
      const digest_v4_s1 = buildSbppChallengeDigest({
        dropId, policyVersion: pv, epoch, sessionNonce: v4s1.nonce,
      });
      // Attacker submits S1's proof in S2's session
      const v4result = sbppVerifyBinding(
        v4store, v4s2.sessionId, v4s2.nonce,
        digest_v4_s1, dropId, pv, epoch,
      );
      if (v4result.valid) v4_success++;

      // V5: Signed capability — server checks session + capability signature
      const v5server = new V5Server();
      const v5s1 = v5server.issueSession();
      const v5s2 = v5server.issueSession();
      const v5digest = lengthPrefixEncode(dropId, pv, epoch);
      // Attacker gets capability signed for S1, tries to use it in S2
      const cap_s1 = v5server.signCapability(v5s1.sessionId, dropId, pv, epoch);
      // Capability is bound to S1's sessionId — verify in S2 should fail
      if (v5server.verify(v5s2.sessionId, v5s2.nonce, v5digest, dropId, pv, epoch, cap_s1)) {
        v5_success++;
      }

      // V6: Per-drop permit — server checks permit bound to session
      const v6server = new V6Server();
      const v6s1 = v6server.issueSession();
      const v6s2 = v6server.issueSession();
      const permit_s1 = v6server.issuePermit(v6s1.sessionId, dropId);
      // Attacker tries permit from S1 in S2 — permit bound to S1 sessionId
      if (v6server.verify(v6s2.sessionId, dropId, permit_s1)) {
        v6_success++;
      }

      // V7: MAC-bound — server checks session + MAC
      const v7server = new V7Server();
      const v7s1 = v7server.issueSession();
      const v7s2 = v7server.issueSession();
      const v7digest = lengthPrefixEncode(dropId, pv, epoch);
      const mac_s1 = v7server.computeResultMac(v7s1.sessionId, [dropId]);
      v7server.computeResultMac(v7s2.sessionId, [dropId]);
      // Attacker uses S1's MAC in S2 — MAC bound to S1 sessionId
      if (v7server.verify(v7s2.sessionId, v7s2.nonce, v7digest, dropId, pv, epoch, mac_s1)) {
        v7_success++;
      }

      // V8: Internalized-token — token hash inside proof's pub[7]
      const v8server = new V8Server();
      const v8s1 = v8server.issueSession();
      const v8s2 = v8server.issueSession();
      const v8tok_s1 = v8server.signToken(v8s1.sessionId, [dropId], pv, epoch);
      v8server.signToken(v8s2.sessionId, [dropId], pv, epoch);
      // Attacker generates digest committing to S1's tokenHash
      const digest_v8_s1 = v8server.buildProofDigest(dropId, pv, epoch, v8tok_s1);
      // Attacker submits S1's digest in S2's session: server recomputes
      // expected digest from S2's tokenHash, finds mismatch → blocked
      if (v8server.verify(v8s2.sessionId, digest_v8_s1, dropId, pv, epoch)) {
        v8_success++;
      }

      // V9: Post-proof signed receipt — proof is session-independent (W1
      // holds), so the attacker's S1-built digest is identical to any
      // S2-built digest. The attacker submits under S2. The server signs
      // a receipt for (S2, dropId, H(pi), t) and appends it to the log.
      // The auditor reads the receipt and unambiguously attributes pi to
      // S2 — which is the session under which submission occurred.
      // Under the post-proof receipt audit semantic, attribution is taken
      // to be the receipt's session id, so the attacker cannot cause a
      // misattribution by swapping which session id is declared at submit.
      const v9server = new V9Server();
      const v9s1 = v9server.issueSession();
      const v9s2 = v9server.issueSession();
      v9server.setResultSet(v9s1.sessionId, [dropId]);
      v9server.setResultSet(v9s2.sessionId, [dropId]);
      const digest_v9 = v9server.buildProofDigest(dropId, pv, epoch);
      // Server accepts the proof and signs a receipt for S2.
      const accepted = v9server.verify(v9s2.sessionId, digest_v9, dropId, pv, epoch);
      // Audit: attribution is from the most recent receipt's sessionId.
      const lastReceipt = v9server.receiptLog[v9server.receiptLog.length - 1];
      const attributed = lastReceipt ? v9server.auditVerify(lastReceipt) : null;
      // "Attack succeeds" iff the auditor's attribution differs from S2
      // (the receipt's session). Under V9's audit semantic, attribution
      // equals the receipt's sessionId, so the attack is blocked.
      if (accepted && attributed !== v9s2.sessionId) {
        v9_success++;
      }
    }

    results.attacks.A1_cross_session = {
      description: 'Cross-session proof reuse: proof from S1 submitted in S2',
      v1_plaintext_zkp: { success_rate: v1_success / N, blocked: v1_success === 0 },
      v2_gridse_only: { success_rate: v2_success / N, blocked: v2_success === 0 },
      v3_app_nonce: { success_rate: v3_success / N, blocked: v3_success === 0 },
      v4_sbpp: { success_rate: v4_success / N, blocked: v4_success === 0 },
      v5_signed_capability: { success_rate: v5_success / N, blocked: v5_success === 0 },
      v6_per_drop_permit: { success_rate: v6_success / N, blocked: v6_success === 0 },
      v7_mac_bound: { success_rate: v7_success / N, blocked: v7_success === 0 },
      v8_internalized_token: { success_rate: v8_success / N, blocked: v8_success === 0 },
      v9_post_proof_receipt: { success_rate: v9_success / N, blocked: v9_success === 0 },
    };
  }

  // ─── A2: Search-verify decorrelation ───
  // Attacker observes search query at time t1 and proof submission at time t2.
  // Can the server link them?
  // In V1/V2: proof contains no session info → server uses timing/metadata
  // In V3: app-layer nonce links them, but a MITM can intercept and relay
  // In V4: proof cryptographically bound to session → even with timing,
  //         server can only confirm the *intended* binding, not infer new links
  {
    let v1_linkable = 0, v2_linkable = 0, v3_linkable = 0, v4_linkable = 0;
    let v5_linkable = 0, v6_linkable = 0, v7_linkable = 0, v8_linkable = 0, v9_linkable = 0;

    for (let i = 0; i < N; i++) {
      // Simulate: attacker intercepts a proof and wants to associate it
      // with a different search session
      const dropId = `drop-${i}`;
      const pv = '1';
      const epoch = '42';

      // V1: server sees geohash in search, sees target coords in proof
      // → trivially linkable by spatial proximity
      v1_linkable++;

      // V2: server sees tokens (not geohash), sees target coords in proof
      // → can link by checking which tokens correspond to the target drop
      // (server stores the drop's index tokens)
      v2_linkable++;

      // V3: server has session ID in both phases → linkable via session
      // BUT: if attacker replaces session ID, proof still verifies
      // (nonce not in proof), so attacker can decorrelate
      const v3server = new V3Server();
      const legit_session = v3server.issueSession();
      const attacker_session = v3server.issueSession();
      const digest = lengthPrefixEncode(dropId, pv, epoch);
      // Attacker submits legit proof under attacker's session
      if (v3server.verify(attacker_session.sessionId, attacker_session.nonce, digest, dropId, pv, epoch)) {
        v3_linkable++; // attacker successfully decorrelated
      }

      // V4: proof is bound to specific nonce → attacker cannot re-associate
      const v4store = new SbppSessionStore();
      const legit_v4 = v4store.issue();
      const attacker_v4 = v4store.issue();
      const digest_v4 = buildSbppChallengeDigest({
        dropId, policyVersion: pv, epoch, sessionNonce: legit_v4.nonce,
      });
      // Attacker submits under different session
      const v4result = sbppVerifyBinding(
        v4store, attacker_v4.sessionId, attacker_v4.nonce,
        digest_v4, dropId, pv, epoch,
      );
      if (v4result.valid) v4_linkable++;

      // V5: capability is bound to sessionId — attacker can't re-associate
      // because capability signature includes sessionId
      const v5server = new V5Server();
      const legit_v5 = v5server.issueSession();
      const attacker_v5 = v5server.issueSession();
      const v5digest = lengthPrefixEncode(dropId, pv, epoch);
      const cap_legit = v5server.signCapability(legit_v5.sessionId, dropId, pv, epoch);
      // Attacker tries to submit legit's proof+capability under attacker's session
      if (v5server.verify(attacker_v5.sessionId, attacker_v5.nonce, v5digest, dropId, pv, epoch, cap_legit)) {
        v5_linkable++;
      }

      // V6: permit is bound to sessionId — attacker can't re-associate
      const v6server = new V6Server();
      const legit_v6 = v6server.issueSession();
      const attacker_v6 = v6server.issueSession();
      const permit_legit = v6server.issuePermit(legit_v6.sessionId, dropId);
      if (v6server.verify(attacker_v6.sessionId, dropId, permit_legit)) {
        v6_linkable++;
      }

      // V7: MAC is bound to sessionId — attacker can't re-associate
      const v7server = new V7Server();
      const legit_v7 = v7server.issueSession();
      const attacker_v7 = v7server.issueSession();
      const v7digest = lengthPrefixEncode(dropId, pv, epoch);
      const mac_legit = v7server.computeResultMac(legit_v7.sessionId, [dropId]);
      v7server.computeResultMac(attacker_v7.sessionId, [dropId]);
      if (v7server.verify(attacker_v7.sessionId, attacker_v7.nonce, v7digest, dropId, pv, epoch, mac_legit)) {
        v7_linkable++;
      }

      // V8: Internalized-token — proof commits to specific tokenHash
      const v8server = new V8Server();
      const legit_v8 = v8server.issueSession();
      const attacker_v8 = v8server.issueSession();
      const tok_legit = v8server.signToken(legit_v8.sessionId, [dropId], pv, epoch);
      v8server.signToken(attacker_v8.sessionId, [dropId], pv, epoch);
      // Legit proof commits to legit_v8's tokenHash
      const digest_legit_v8 = v8server.buildProofDigest(dropId, pv, epoch, tok_legit);
      // Attacker tries to re-associate under attacker's session
      if (v8server.verify(attacker_v8.sessionId, digest_legit_v8, dropId, pv, epoch)) {
        v8_linkable++;
      }

      // V9: Post-proof receipt — proof is session-independent. The
      // attacker submits the legitimate proof under the attacker's
      // session; the server signs a receipt for the attacker's session.
      // The auditor's attribution follows the receipt unambiguously, so
      // there is no audit re-association ambiguity left to exploit.
      const v9server = new V9Server();
      const legit_v9 = v9server.issueSession();
      const attacker_v9 = v9server.issueSession();
      v9server.setResultSet(legit_v9.sessionId, [dropId]);
      v9server.setResultSet(attacker_v9.sessionId, [dropId]);
      const v9digest = v9server.buildProofDigest(dropId, pv, epoch);
      const v9accepted = v9server.verify(attacker_v9.sessionId, v9digest, dropId, pv, epoch);
      const v9receipt = v9server.receiptLog[v9server.receiptLog.length - 1];
      const v9attr = v9receipt ? v9server.auditVerify(v9receipt) : null;
      if (v9accepted && v9attr !== attacker_v9.sessionId) {
        v9_linkable++;
      }
    }

    results.attacks.A2_decorrelation = {
      description: 'Search-verify decorrelation: attacker reassociates proof with different session',
      v1_plaintext_zkp: { attack_success: v1_linkable / N, vulnerable: true },
      v2_gridse_only: { attack_success: v2_linkable / N, vulnerable: true },
      v3_app_nonce: { attack_success: v3_linkable / N, vulnerable: true },
      v4_sbpp: { attack_success: v4_linkable / N, vulnerable: v4_linkable > 0 },
      v5_signed_capability: { attack_success: v5_linkable / N, vulnerable: v5_linkable > 0 },
      v6_per_drop_permit: { attack_success: v6_linkable / N, vulnerable: v6_linkable > 0 },
      v7_mac_bound: { attack_success: v7_linkable / N, vulnerable: v7_linkable > 0 },
      v8_internalized_token: { attack_success: v8_linkable / N, vulnerable: v8_linkable > 0 },
      v9_post_proof_receipt: { attack_success: v9_linkable / N, vulnerable: v9_linkable > 0 },
    };
  }

  // ─── A3: Proof transfer between drops ───
  // Attacker generates proof for drop-A, submits for drop-B
  {
    let v1_success = 0, v2_success = 0, v3_success = 0, v4_success = 0;
    let v5_success = 0, v6_success = 0, v7_success = 0, v8_success = 0, v9_success = 0;

    for (let i = 0; i < N; i++) {
      const dropA = `drop-A-${i}`;
      const dropB = `drop-B-${i}`;
      const pv = '1';
      const epoch = '42';

      // All variants include dropId in the digest, so cross-drop transfer
      // is prevented in all four. This confirms SBPP inherits this from
      // the base context binding.
      const digest_A_v1 = lengthPrefixEncode(dropA, pv, epoch);
      if (v1_verify(digest_A_v1, dropB, pv, epoch)) v1_success++;
      if (v2_verify(digest_A_v1, dropB, pv, epoch)) v2_success++;

      const v3server = new V3Server();
      const s = v3server.issueSession();
      if (v3server.verify(s.sessionId, s.nonce, digest_A_v1, dropB, pv, epoch)) v3_success++;

      const v4store = new SbppSessionStore();
      const v4s = v4store.issue();
      const digest_A_v4 = buildSbppChallengeDigest({
        dropId: dropA, policyVersion: pv, epoch, sessionNonce: v4s.nonce,
      });
      const v4r = sbppVerifyBinding(
        v4store, v4s.sessionId, v4s.nonce,
        digest_A_v4, dropB, pv, epoch,
      );
      if (v4r.valid) v4_success++;

      // V5: capability is signed for dropA — verify for dropB fails
      const v5server = new V5Server();
      const v5s = v5server.issueSession();
      const cap_A = v5server.signCapability(v5s.sessionId, dropA, pv, epoch);
      const v5digest_A = lengthPrefixEncode(dropA, pv, epoch);
      if (v5server.verify(v5s.sessionId, v5s.nonce, v5digest_A, dropB, pv, epoch, cap_A)) {
        v5_success++;
      }

      // V6: permit is issued for dropA — verify for dropB fails
      const v6server = new V6Server();
      const v6s = v6server.issueSession();
      const permit_A = v6server.issuePermit(v6s.sessionId, dropA);
      if (v6server.verify(v6s.sessionId, dropB, permit_A)) {
        v6_success++;
      }

      // V7: MAC covers result set — proof digest for dropA won't match dropB
      const v7server = new V7Server();
      const v7s = v7server.issueSession();
      const mac = v7server.computeResultMac(v7s.sessionId, [dropA, dropB]);
      const v7digest_A = lengthPrefixEncode(dropA, pv, epoch);
      // Even though both drops are in result set, proof digest is for dropA
      if (v7server.verify(v7s.sessionId, v7s.nonce, v7digest_A, dropB, pv, epoch, mac)) {
        v7_success++;
      }

      // V8: Token covers result set with sorted dropIds; proof digest commits
      // to the resulting tokenHash AND to the specific dropId. Cross-drop
      // transfer fails: digest for dropA does not match digest for dropB.
      const v8server = new V8Server();
      const v8s = v8server.issueSession();
      const tok_v8 = v8server.signToken(v8s.sessionId, [dropA, dropB], pv, epoch);
      const digest_A_v8 = v8server.buildProofDigest(dropA, pv, epoch, tok_v8);
      // Submit digest for dropA but claim dropB
      if (v8server.verify(v8s.sessionId, digest_A_v8, dropB, pv, epoch)) {
        v8_success++;
      }

      // V9: Post-proof receipt — the proof digest commits to dropA; the
      // server's verify recomputes the expected digest for the declared
      // dropB and rejects the mismatch.
      const v9server = new V9Server();
      const v9s = v9server.issueSession();
      v9server.setResultSet(v9s.sessionId, [dropA, dropB]);
      const digest_A_v9 = v9server.buildProofDigest(dropA, pv, epoch);
      if (v9server.verify(v9s.sessionId, digest_A_v9, dropB, pv, epoch)) {
        v9_success++;
      }
    }

    results.attacks.A3_cross_drop = {
      description: 'Cross-drop proof transfer: proof for drop-A submitted for drop-B',
      v1_plaintext_zkp: { success_rate: v1_success / N, blocked: v1_success === 0 },
      v2_gridse_only: { success_rate: v2_success / N, blocked: v2_success === 0 },
      v3_app_nonce: { success_rate: v3_success / N, blocked: v3_success === 0 },
      v4_sbpp: { success_rate: v4_success / N, blocked: v4_success === 0 },
      v5_signed_capability: { success_rate: v5_success / N, blocked: v5_success === 0 },
      v6_per_drop_permit: { success_rate: v6_success / N, blocked: v6_success === 0 },
      v7_mac_bound: { success_rate: v7_success / N, blocked: v7_success === 0 },
      v8_internalized_token: { success_rate: v8_success / N, blocked: v8_success === 0 },
      v9_post_proof_receipt: { success_rate: v9_success / N, blocked: v9_success === 0 },
    };
  }

  // ─── A4: Result-set escape ───
  // Attacker proves proximity to a drop NOT in the search results.
  // V4a (Core, nonce only): no result-set binding → attack succeeds
  // V4b (Full, nonce + rd): result-set digest committed → attack fails
  {
    let v4a_success = 0, v4b_success = 0;
    let v5_success = 0, v6_success = 0, v7_success = 0, v8_success = 0, v9_success = 0;

    for (let i = 0; i < N; i++) {
      const dropInResults = `drop-in-${i}`;
      const dropOutside = `drop-outside-${i}`;
      const pv = '1';
      const epoch = '42';

      // V4a: Core SBPP (nonce only, no rd)
      const v4a_store = new SbppSessionStore();
      const v4a_session = v4a_store.issue();
      // Simulate: search returned dropInResults, but attacker proves dropOutside
      const digest_v4a = buildSbppChallengeDigest({
        dropId: dropOutside, policyVersion: pv, epoch,
        sessionNonce: v4a_session.nonce,
        // NO resultSetDigest → Core mode
      });
      const v4a_result = sbppVerifyBinding(
        v4a_store, v4a_session.sessionId, v4a_session.nonce,
        digest_v4a, dropOutside, pv, epoch,
      );
      if (v4a_result.valid) v4a_success++;

      // V4b: Full SBPP (nonce + rd)
      const v4b_store = new SbppSessionStore();
      const v4b_session = v4b_store.issue();
      // Simulate search that returned only dropInResults
      const rd = computeResultSetDigest(v4b_session.sessionId, [dropInResults], 5);
      v4b_store.setResultDigest(v4b_session.sessionId, rd);
      v4b_store.setCandidateSet(v4b_session.sessionId, new Set([dropInResults]));
      // Attacker tries to prove dropOutside with correct rd
      const digest_v4b = buildSbppChallengeDigest({
        dropId: dropOutside, policyVersion: pv, epoch,
        sessionNonce: v4b_session.nonce,
        resultSetDigest: rd,
      });
      const v4b_result = sbppVerifyBinding(
        v4b_store, v4b_session.sessionId, v4b_session.nonce,
        digest_v4b, dropOutside, pv, epoch,
      );
      if (v4b_result.valid) v4b_success++;

      // V5: Signed capability — server tracks result set and checks membership
      const v5server = new V5Server();
      const v5s = v5server.issueSession();
      v5server.setResultSet(v5s.sessionId, [dropInResults]);
      // Attacker gets a capability for dropOutside (server wouldn't normally issue this,
      // but even if attacker forges a request, result-set check catches it)
      // In the honest path, server only signs capabilities for drops in results.
      // Simulate attacker somehow obtaining capability for dropOutside:
      const cap_outside = v5server.signCapability(v5s.sessionId, dropOutside, pv, epoch);
      const v5digest = lengthPrefixEncode(dropOutside, pv, epoch);
      if (v5server.verify(v5s.sessionId, v5s.nonce, v5digest, dropOutside, pv, epoch, cap_outside)) {
        v5_success++;
      }

      // V6: Per-drop permit — server only issues permits for drops in results
      // If attacker doesn't have a permit for dropOutside, verify fails
      const v6server = new V6Server();
      const v6s = v6server.issueSession();
      v6server.issuePermit(v6s.sessionId, dropInResults); // only issue for in-results
      // Attacker tries to verify dropOutside without a valid permit
      const fakePermit = createHash('sha256').update('fake').digest('hex');
      if (v6server.verify(v6s.sessionId, dropOutside, fakePermit)) {
        v6_success++;
      }

      // V7: MAC-bound — MAC covers the result set, server checks membership
      const v7server = new V7Server();
      const v7s = v7server.issueSession();
      const mac = v7server.computeResultMac(v7s.sessionId, [dropInResults]);
      const v7digest = lengthPrefixEncode(dropOutside, pv, epoch);
      // Attacker tries to prove dropOutside — not in result set
      if (v7server.verify(v7s.sessionId, v7s.nonce, v7digest, dropOutside, pv, epoch, mac)) {
        v7_success++;
      }

      // V8: Token includes the actual result set; server.verify() also checks
      // membership. Attacker tries to prove dropOutside which is not in tokenHash.
      const v8server = new V8Server();
      const v8s = v8server.issueSession();
      const tok = v8server.signToken(v8s.sessionId, [dropInResults], pv, epoch);
      // Attacker computes a digest for dropOutside using the legitimate tokenHash
      const digest_outside_v8 = v8server.buildProofDigest(dropOutside, pv, epoch, tok);
      if (v8server.verify(v8s.sessionId, digest_outside_v8, dropOutside, pv, epoch)) {
        v8_success++;
      }

      // V9: Post-proof receipt — the server checks the dropId against the
      // session's recorded result set at proof acceptance. dropOutside is
      // not in the result set, so verify rejects before any receipt is
      // signed.
      const v9server = new V9Server();
      const v9s = v9server.issueSession();
      v9server.setResultSet(v9s.sessionId, [dropInResults]);
      const digest_outside_v9 = v9server.buildProofDigest(dropOutside, pv, epoch);
      if (v9server.verify(v9s.sessionId, digest_outside_v9, dropOutside, pv, epoch)) {
        v9_success++;
      }
    }

    results.attacks.A4_result_set_escape = {
      description: 'Result-set escape: proof for drop NOT in search results',
      v4a_core_nonce_only: { success_rate: v4a_success / N, blocked: v4a_success === 0 },
      v4b_full_nonce_plus_rd: { success_rate: v4b_success / N, blocked: v4b_success === 0 },
      v5_signed_capability: { success_rate: v5_success / N, blocked: v5_success === 0 },
      v6_per_drop_permit: { success_rate: v6_success / N, blocked: v6_success === 0 },
      v7_mac_bound: { success_rate: v7_success / N, blocked: v7_success === 0 },
      v8_internalized_token: { success_rate: v8_success / N, blocked: v8_success === 0 },
      v9_post_proof_receipt: { success_rate: v9_success / N, blocked: v9_success === 0 },
    };
  }

  // ─── A4b: Transcript-level audit ───
  // Can an auditor WITHOUT the server's secret key verify that authorization
  // was legitimate, given only the protocol transcript?
  // V4a/V5/V7: server secret required → auditor CANNOT verify
  // V4b: Merkle root in proof + receipt signature → auditor CAN verify
  // V6: no proof at all → auditor cannot verify proximity
  {
    // This is a qualitative/structural test, not a brute-force one.
    // We simulate whether the auditor can reconstruct verification from transcript only.

    const auditResults = {};

    // V4a (Core SBPP): auditor sees proof with nonce, but cannot verify
    // that nonce was legitimately issued without server session store access.
    // However, the nonce IS in the proof public input — auditor can verify
    // the proof is valid for that nonce, but cannot confirm nonce freshness.
    auditResults.v4a_core = {
      auditor_can_verify_proof: true,
      auditor_can_verify_authorization: false,
      reason: 'Nonce in proof is verifiable, but auditor cannot confirm nonce was freshly issued by server',
    };

    // V4b (Full SBPP): Merkle root rd is committed in proof public input,
    // and server issues a signed receipt. Auditor can verify:
    // 1. Proof is valid (ZKP verification)
    // 2. rd in proof matches the result set (Merkle proof)
    // 3. Receipt signature is valid (public key verification)
    auditResults.v4b_full = {
      auditor_can_verify_proof: true,
      auditor_can_verify_authorization: true,
      reason: 'Merkle root in proof + signed receipt — auditor verifies ZKP, Merkle inclusion, and receipt signature without server secret',
    };

    // V5: capability is HMAC-signed with server secret.
    // Auditor cannot verify HMAC without the server's signing key.
    auditResults.v5_signed_capability = {
      auditor_can_verify_proof: true,
      auditor_can_verify_authorization: false,
      reason: 'Capability is HMAC-signed with server secret — auditor cannot verify without key',
    };

    // V6: no ZKP at all — auditor cannot verify proximity.
    auditResults.v6_per_drop_permit = {
      auditor_can_verify_proof: false,
      auditor_can_verify_authorization: false,
      reason: 'No ZKP — permit is server-signed; auditor cannot verify proximity or authorization without server key',
    };

    // V7: MAC is computed with server-side secret key.
    // Auditor cannot verify MAC without the MAC key.
    auditResults.v7_mac_bound = {
      auditor_can_verify_proof: true,
      auditor_can_verify_authorization: false,
      reason: 'MAC key is server secret — auditor cannot verify result-set binding without key',
    };

    // V8: Token is signed with a server signing key (asymmetric/public-key
    // assumed). Auditor holds the public verification key only and can
    // recompute the expected proofDigest from the logged token. Audit
    // succeeds, but the failure mode (if any) is undifferentiated:
    // the token bundles session+resultSet+params into one opaque hash,
    // so a "hash mismatch" reveals only that *something* is wrong.
    auditResults.v8_internalized_token = {
      auditor_can_verify_proof: true,
      auditor_can_verify_authorization: true,
      fault_localization: 'undifferentiated (single opaque hash)',
      reason: 'Server-signed token committed in proof public input — auditor verifies with server public key but cannot distinguish which property (P1/P2/P3) failed on mismatch',
    };

    // V9: Post-proof signed receipt. The auditor verifies the receipt
    // signature with the server's public key and reads the attributed
    // sessionId from the receipt. Audit succeeds offline, but with two
    // additional trust assumptions compared to V4b: (i) the server was
    // online and willing to sign at proof acceptance time, and
    // (ii) the audit log was finalised server-side without post-hoc
    // receipt rewrites.
    auditResults.v9_post_proof_receipt = {
      auditor_can_verify_proof: true,
      auditor_can_verify_authorization: true,
      trust_boundary: 'server signing at acceptance + server-side log finalisation',
      reason: 'Server signs Sig_S(sessionId, dropId, H(pi), t) at proof acceptance; auditor verifies the receipt with server public key. The audit record is finalised server-side rather than client-side as in V4b.',
    };

    results.attacks.A4b_transcript_audit = {
      description: 'Transcript-level audit: can auditor without server secret verify authorization?',
      ...auditResults,
    };
  }

  // ═══════════════════════════════════════
  // Summary matrix
  // ═══════════════════════════════════════
  results.summary = {
    description: 'Attack success matrix (true = attack succeeds, vulnerable)',
    matrix: {
      'A1 cross-session':     { V1: true,  V2: true,  V3: true,  V4a: false, V4b: false, V5: false, V6: false, V7: false, V8: false, V9: false },
      'A2 re-association':    { V1: true,  V2: true,  V3: true,  V4a: false, V4b: false, V5: false, V6: false, V7: false, V8: false, V9: false },
      'A3 cross-drop':        { V1: false, V2: false, V3: false, V4a: false, V4b: false, V5: false, V6: false, V7: false, V8: false, V9: false },
      'A4 result-set escape': { V1: true,  V2: true,  V3: true,  V4a: true,  V4b: false, V5: false, V6: false, V7: false, V8: false, V9: false },
      'A4b transcript audit': { V1: true,  V2: true,  V3: true,  V4a: true,  V4b: false, V5: true,  V6: true,  V7: true,  V8: false, V9: false },
    },
    note: 'A1/A2 require session binding. A4 requires result-set binding. A4b requires publicly verifiable authorization. V4b, V8, and V9 all block A1-A4 and admit transcript-level audit; the differentiators are operational. V8 requires modifying the ZK circuit + re-running trusted setup; V9 requires the server to be online and willing to sign at proof acceptance, with audit integrity coupled to server-side log finalisation; V4b binds at search time inside the existing circuit, finalises the audit record client-side, and is verifiable offline using only the server public key.',
    key_finding: 'V5/V6/V7 block online attacks (A1-A4) via server-side checks, but fail A4b (transcript audit) because authorization depends on server secrets. V4b (Full SBPP), V8 (internalized-token), and V9 (post-proof signed receipt) all achieve publicly auditable authorization. V8 carries circuit-modification + trusted-setup-rotation costs; V9 carries an online-server + server-side-log-finalisation trust dependency; V4b reuses the deployed circuit and finalises the audit record client-side.',
  };

  return results;
}

// ═══════════════════════════════════════
// Run
// ═══════════════════════════════════════

// ═══════════════════════════════════════
// Latency micro-benchmark: V9 post-proof signing overhead
// ═══════════════════════════════════════
//
// The interesting deterministic cost of V9 versus V4 is the post-proof
// signing step the server performs at proof acceptance: hashing the
// receipt payload and appending the signed receipt to an append-only
// log. We isolate this step rather than comparing the full V4 vs V9
// protocol paths, because the two paths construct different digests
// (V4 hashes nonce + Merkle root + ctx; V9 hashes only drop + pv +
// epoch) and a wall-clock comparison conflates session-binding hashing
// with post-proof signing.
//
// We also report the full V4 and V9 protocol paths for reference, and
// the mobile end-to-end cost is taken from §7 (warm-mobile measurement)
// — the receipt-return-to-client variant of V9 adds 50-200 ms on 4G,
// independent of the protocol-layer cost.
function runLatencyBench(reps = 10000, warmup = 2000) {
  const dropId = 'bench-drop';
  const pv = '1';
  const epoch = '42';

  function stats(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      n: sorted.length,
      mean_ns: sum / sorted.length,
      median_ns: sorted[Math.floor(sorted.length / 2)],
      p95_ns: sorted[Math.floor(sorted.length * 0.95)],
      p99_ns: sorted[Math.floor(sorted.length * 0.99)],
      min_ns: sorted[0],
      max_ns: sorted[sorted.length - 1],
    };
  }

  // --- Post-proof signing overhead (V9 minus V4) ---
  // Pre-build a session and digest; measure only the steps V9 performs
  // at proof acceptance that V4 does not: receipt-payload hash + signed
  // receipt computation + log append.
  const signingSrv = new V9Server();
  const signingSess = signingSrv.issueSession();
  signingSrv.setResultSet(signingSess.sessionId, [dropId]);
  const signingDigest = signingSrv.buildProofDigest(dropId, pv, epoch);

  for (let i = 0; i < warmup; i++) {
    const proofHash = createHash('sha256').update(signingDigest).digest('hex');
    const receiptMsg = `${signingSess.sessionId}:${dropId}:${proofHash}:${Date.now()}`;
    createHash('sha256').update(signingSrv.signingKey + receiptMsg).digest('hex');
  }
  const sign_samples = new Array(reps);
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    const proofHash = createHash('sha256').update(signingDigest).digest('hex');
    const receiptMsg = `${signingSess.sessionId}:${dropId}:${proofHash}:${Date.now()}`;
    const receipt = createHash('sha256').update(signingSrv.signingKey + receiptMsg).digest('hex');
    signingSrv.receiptLog.push({ sessionId: signingSess.sessionId, dropId, proofHash, ts: Date.now(), receipt });
    const t1 = process.hrtime.bigint();
    sign_samples[i] = Number(t1 - t0);
  }
  const signing_stats = stats(sign_samples);

  // --- Full V4 protocol path (reference) ---
  for (let i = 0; i < warmup; i++) {
    const s = new SbppSessionStore();
    const t = s.issue();
    const d = buildSbppChallengeDigest({ dropId, policyVersion: pv, epoch, sessionNonce: t.nonce });
    sbppVerifyBinding(s, t.sessionId, t.nonce, d, dropId, pv, epoch);
  }
  const v4_samples = new Array(reps);
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    const store = new SbppSessionStore();
    const sess = store.issue();
    const digest = buildSbppChallengeDigest({
      dropId, policyVersion: pv, epoch, sessionNonce: sess.nonce,
    });
    sbppVerifyBinding(store, sess.sessionId, sess.nonce, digest, dropId, pv, epoch);
    const t1 = process.hrtime.bigint();
    v4_samples[i] = Number(t1 - t0);
  }
  const v4_stats = stats(v4_samples);

  // --- Full V9 protocol path (reference) ---
  for (let i = 0; i < warmup; i++) {
    const s = new V9Server();
    const t = s.issueSession();
    s.setResultSet(t.sessionId, [dropId]);
    const d = s.buildProofDigest(dropId, pv, epoch);
    s.verify(t.sessionId, d, dropId, pv, epoch);
  }
  const v9_samples = new Array(reps);
  for (let i = 0; i < reps; i++) {
    const t0 = process.hrtime.bigint();
    const srv = new V9Server();
    const sess = srv.issueSession();
    srv.setResultSet(sess.sessionId, [dropId]);
    const digest = srv.buildProofDigest(dropId, pv, epoch);
    srv.verify(sess.sessionId, digest, dropId, pv, epoch);
    const t1 = process.hrtime.bigint();
    v9_samples[i] = Number(t1 - t0);
  }
  const v9_stats = stats(v9_samples);

  return {
    description: 'Isolated post-proof signing overhead and full protocol-path latency (excluding Groth16 prove/verify).',
    reps,
    warmup,
    isolated_post_proof_signing: signing_stats,
    full_path_v4_sbpp: v4_stats,
    full_path_v9_post_proof_receipt: v9_stats,
    note: 'isolated_post_proof_signing is the V9-only cost above V4 at the protocol layer: receipt-payload SHA-256, signed-receipt SHA-256, and append-only log push. full_path_v4_sbpp vs full_path_v9_post_proof_receipt include unrelated session-binding work and should not be subtracted directly. The substantive operational cost of V9 is the online-server requirement, not the microsecond signing step: receipt-return-to-client over 4G adds 50-200 ms (taken from §7 mobile measurements) when the deployment requires client-side finalisation of the audit record before completion.',
  };
}

const results = runAttacks();
results.latency_v4_vs_v9 = runLatencyBench();

process.stdout.write(JSON.stringify(results, null, 2));

// Summary to stderr
process.stderr.write('\n=== Naive Composition Attack Comparison ===\n\n');
process.stderr.write('Attack                  V1(plain) V2(GridSE) V3(nonce) V4a(Core) V4b(Full) V5(Cap)   V6(Permit) V7(MAC)   V8(Token) V9(Receipt)\n');
process.stderr.write('─'.repeat(132) + '\n');
for (const [attack, data] of Object.entries(results.summary.matrix)) {
  const row = [attack.padEnd(24)];
  for (const v of ['V1', 'V2', 'V3', 'V4a', 'V4b', 'V5', 'V6', 'V7', 'V8', 'V9']) {
    row.push(data[v] ? '  VULN  ' : 'BLOCKED ');
  }
  process.stderr.write(row.join(' ') + '\n');
}
process.stderr.write('\n' + results.summary.key_finding + '\n');

const lb = results.latency_v4_vs_v9;
process.stderr.write('\n=== Latency micro-benchmark ===\n');
process.stderr.write(`Reps: ${lb.reps} (warmup ${lb.warmup})\n`);
process.stderr.write(`V9 isolated post-proof signing  median ${(lb.isolated_post_proof_signing.median_ns / 1000).toFixed(2)} us, p95 ${(lb.isolated_post_proof_signing.p95_ns / 1000).toFixed(2)} us, p99 ${(lb.isolated_post_proof_signing.p99_ns / 1000).toFixed(2)} us\n`);
process.stderr.write(`V4 SBPP full path               median ${(lb.full_path_v4_sbpp.median_ns / 1000).toFixed(2)} us, p95 ${(lb.full_path_v4_sbpp.p95_ns / 1000).toFixed(2)} us, p99 ${(lb.full_path_v4_sbpp.p99_ns / 1000).toFixed(2)} us\n`);
process.stderr.write(`V9 full path                    median ${(lb.full_path_v9_post_proof_receipt.median_ns / 1000).toFixed(2)} us, p95 ${(lb.full_path_v9_post_proof_receipt.p95_ns / 1000).toFixed(2)} us, p99 ${(lb.full_path_v9_post_proof_receipt.p99_ns / 1000).toFixed(2)} us\n`);
process.stderr.write('Note: full-path V4 and V9 do unrelated work (V4 hashes nonce/Merkle/ctx; V9 hashes drop/pv/epoch + receipt). The substantive V9 cost is the online-server requirement, not the microsecond signing step.\n');
