# Acceptance Predicates and Required Invariants

Maps the paper's §V-C acceptance predicates to code. Each strategy's verifier-side conditions
are listed with their source file, line number, and the invariant they enforce.

## Strategy 2c-hardened (Stored-Digest Server Checking)

**Acceptance predicate:**
Accept iff:
1. Groth16.Verify(vk, pub, π) = 1
2. nonce-to-drop map resolves N to the claimed drop
3. pub[7] matches the stored challenge digest for (dropId, epoch, N)

**Required operational invariants:**

| ID | Invariant | Code location | Failure mode |
|----|-----------|---------------|--------------|
| I1 | Nonce-to-drop mapping | `strategy-2c-implementation.mjs:258` | F4: mapping mismatch |
| I2 | Nonce uniqueness | `strategy-2c-implementation.mjs:88` | F1: double-spend |
| I3 | Nonce freshness | `strategy-2c-implementation.mjs:89` | F2: stale mapping |
| I4 | Challenge-digest consistency | `strategy-2c-implementation.mjs:272` | F6: cross-drop transfer |

**Server state:** O(k·U) — one row per (drop, user, nonce)

**Regression tests:** `test-2c-invariant-regression.mjs`

---

## Strategy 2c-default (Naive — Missing I4)

Same as 2c-hardened but **omits I4** (pub[7] check).

**Acceptance predicate:**
Accept iff:
1. Groth16.Verify(vk, pub, π) = 1
2. nonce-to-drop map resolves N to the claimed drop

**Vulnerability:** Scenario G — a proof generated for drop A with shared nonce
is accepted for drop B because pub[7] is not checked against the stored digest.

**Code:** `strategy-2c-implementation.mjs:196` (`verifyProofNaive`)

---

## Strategy 3a (In-Proof Nonce, Level ii)

**Acceptance predicate:**
Accept iff:
1. Groth16.Verify(vk, pub, π) = 1
2. pub matches (1, geo_j, epoch_j, N_j)

**Required assumptions:** Cryptographic (Groth16 soundness) + correct nonce issuance

**Vulnerability:** Scenario G (same-epoch, same-location) — all public signals are
identical for co-located drops sharing an epoch nonce (Lemma 1).

---

## Strategy 3b (In-Proof Context, Level iii — Zairn-ZKP)

**Acceptance predicate:**
Accept iff:
1. Groth16.Verify(vk, pub, π) = 1
2. pub matches (1, geo_j, C_j, epoch_j, N_j)
   where C_j = H(LP(dropId_j, pv_j, epoch_j))

**Required assumptions:**
- Cryptographic: Groth16 knowledge soundness, SHA-256 collision resistance
- Operational: Correct backend issuance (each rec_i matches context at issuance)

**Required operational invariants:** |A_op| = 2 (vs 4 for 2c-hardened)

**Server state:** O(1) — epoch nonce is stateless

**Code:** `strategy-2c-implementation.mjs:356` (`Strategy3bServer.verifyProof`)

---

## Invariant-to-Test Matrix

| Invariant | 2c-hardened | 2c-default | 3a | 3b | Test |
|-----------|-------------|------------|----|----|------|
| I1: Nonce-to-drop mapping | Enforced | Enforced | N/A | N/A | `test-2c-invariant-regression.mjs` |
| I2: Nonce uniqueness | Enforced | Enforced | N/A | N/A | `test-2c-invariant-regression.mjs` |
| I3: Nonce freshness | Enforced | Enforced | N/A | N/A | `test-2c-invariant-regression.mjs` |
| I4: Challenge-digest (pub[7]) | Enforced | **MISSING** | N/A | N/A | `test-2c-invariant-regression.mjs` |
| Groth16 soundness | Assumed | Assumed | Assumed | Assumed | All evaluation scripts |
| SHA-256 collision resistance | — | — | — | Assumed | `test-encoding-regression.mjs` |
| Correct issuance | Required | Required | Required | Required | `evaluate-operational-drift.mjs` |

## Evaluation Script Mapping

| Script | Table/Section | Strategies tested |
|--------|---------------|-------------------|
| `evaluate-off-circuit-baseline.mjs` | Table off-circuit | 1, 2a, 2b, 2c, 3b |
| `evaluate-cross-drop-attack.mjs` | §VII-D | Prototype, 3a, 3b |
| `benchmark-2c-vs-3b.mjs` | Table impl-complexity | 2c-default, 2c-hardened, 3b |
| `evaluate-same-policy-comparison.mjs` | Table same-policy | 2c-hardened, 2d, 3a, 3b |
| `evaluate-epoch-vulnerability.mjs` | Table epoch-vuln | Level ii vs iii |
| `evaluate-operational-drift.mjs` | Table drift | Recomputed, stored, in-proof |
| `evaluate-defense-in-depth.mjs` | — | Multi-layer defense |
| `sensitivity-rtt-k.mjs` | Table sensitivity | 2c, 3b |
| `evaluate-multi-drop-venue.mjs` | §VII-C | Level ii, iii |
| `evaluate-geometric-accuracy.mjs` | Table geo-accuracy | Circuit accuracy |
| `test-encoding-regression.mjs` | — | Encoding correctness |
| `test-2c-invariant-regression.mjs` | — | 2c invariant enforcement |
