/**
 * SBPP vs V8: Fault-Localization Audit Evaluation
 *
 * Injects three fault types into audit records and compares
 * the diagnostic output of V8 (opaque hash) vs Full SBPP
 * (decomposed components).
 *
 * Fault types:
 *   1. Session rebinding: swap session nonce
 *   2. Result-set tampering: alter Merkle root
 *   3. Fabricated context: forge receipt signature
 *
 * For each, reports whether the audit procedure returns:
 *   - V8: "hash mismatch" (undifferentiated)
 *   - SBPP: specific component failure
 */

import { createHash, randomBytes, sign, verify, generateKeyPairSync } from 'node:crypto';

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function lpEncode(...fields) {
  const parts = fields.map(f => {
    const s = String(f);
    return `${s.length}:${s}`;
  });
  return parts.join('|');
}

// ═══════════════════════════════════════════════════════
// Key pair for receipt signing
// ═══════════════════════════════════════════════════════

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

function signReceipt(data) {
  return sign(null, Buffer.from(data), privateKey);
}

function verifyReceipt(data, signature) {
  try {
    return verify(null, Buffer.from(data), publicKey, signature);
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════
// Merkle tree (minimal binary)
// ═══════════════════════════════════════════════════════

function merkleLeaf(dropId) {
  return sha256(lpEncode('SBPP-LEAF', dropId));
}

function merkleNode(left, right) {
  return sha256(lpEncode('SBPP-NODE', left, right));
}

function buildMerkleTree(dropIds) {
  const sorted = [...dropIds].sort();
  let layer = sorted.map(id => merkleLeaf(id));
  if (layer.length === 0) return { root: sha256('empty'), layers: [] };
  const layers = [layer];
  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 < layer.length) {
        next.push(merkleNode(layer[i], layer[i + 1]));
      } else {
        next.push(layer[i]);
      }
    }
    layer = next;
    layers.push(layer);
  }
  return { root: layer[0], layers, sortedIds: sorted };
}

function getMerklePath(tree, dropId) {
  const leaf = merkleLeaf(dropId);
  let idx = tree.layers[0].indexOf(leaf);
  if (idx === -1) return null;
  const path = [];
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const layer = tree.layers[level];
    const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (sibling < layer.length) {
      path.push({ hash: layer[sibling], position: idx % 2 === 0 ? 'right' : 'left' });
    }
    idx = Math.floor(idx / 2);
  }
  return path;
}

function verifyMerklePath(dropId, path, expectedRoot) {
  let hash = merkleLeaf(dropId);
  for (const step of path) {
    if (step.position === 'right') {
      hash = merkleNode(hash, step.hash);
    } else {
      hash = merkleNode(step.hash, hash);
    }
  }
  return hash === expectedRoot;
}

// ═══════════════════════════════════════════════════════
// SBPP digest
// ═══════════════════════════════════════════════════════

function sbppDigest(dropId, pv, epoch, nonce, root) {
  return sha256(lpEncode('SBPP-v1', dropId, pv, epoch, nonce, root));
}

// ═══════════════════════════════════════════════════════
// V8: opaque token hash
// ═══════════════════════════════════════════════════════

function v8TokenData(sessionId, nonce, root, dropId, pv, epoch) {
  return lpEncode('V8-TOKEN', sessionId, nonce, root, dropId, pv, epoch);
}

function v8Digest(tokenData, signature) {
  // V8 hashes the signed token blob into pub[7]
  return sha256(tokenData + '|' + signature.toString('hex'));
}

// ═══════════════════════════════════════════════════════
// Generate honest session
// ═══════════════════════════════════════════════════════

function createHonestSession() {
  const sessionId = randomBytes(16).toString('hex');
  const nonce = randomBytes(32).toString('hex');
  const pv = '1';
  const epoch = '2026';
  const dropIds = ['drop-A', 'drop-B', 'drop-C', 'drop-D', 'drop-E'];
  const tree = buildMerkleTree(dropIds);
  const root = tree.root;
  const targetDrop = 'drop-C';

  // Receipt
  const receiptData = lpEncode(sessionId, nonce, root, pv, epoch);
  const receiptSig = signReceipt(receiptData);

  // SBPP digest
  const cd = sbppDigest(targetDrop, pv, epoch, nonce, root);

  // Merkle path
  const merklePath = getMerklePath(tree, targetDrop);

  // V8 token
  const tokenData = v8TokenData(sessionId, nonce, root, targetDrop, pv, epoch);
  const tokenSig = signReceipt(tokenData);
  const v8cd = v8Digest(tokenData, tokenSig);

  return {
    sessionId, nonce, pv, epoch, dropIds, tree, root, targetDrop,
    receiptData, receiptSig,
    cd, merklePath,
    tokenData, tokenSig, v8cd,
  };
}

// ═══════════════════════════════════════════════════════
// Audit procedures
// ═══════════════════════════════════════════════════════

function sbppAudit(params) {
  const { targetDrop, pv, epoch, nonce, root, receiptData, receiptSig, cd, merklePath } = params;
  const failures = [];

  // Step 1: receipt signature
  if (!verifyReceipt(receiptData, receiptSig)) {
    failures.push('receipt_signature_failure');
  }

  // Step 2: digest recomputation
  const expectedCd = sbppDigest(targetDrop, pv, epoch, nonce, root);
  if (cd !== expectedCd) {
    failures.push('nonce_or_digest_mismatch');
  }

  // Step 3: Merkle membership
  if (!verifyMerklePath(targetDrop, merklePath, root)) {
    failures.push('merkle_witness_failure');
  }

  return failures.length === 0 ? { pass: true, diagnosis: 'all_checks_pass' }
    : { pass: false, diagnosis: failures.join(', ') };
}

function v8Audit(params) {
  const { tokenData, tokenSig, v8cd } = params;
  const failures = [];

  // Step 1: token signature
  if (!verifyReceipt(tokenData, tokenSig)) {
    failures.push('hash_mismatch');
    return { pass: false, diagnosis: 'hash_mismatch (opaque)' };
  }

  // Step 2: hash recomputation
  const expectedV8cd = v8Digest(tokenData, tokenSig);
  if (v8cd !== expectedV8cd) {
    failures.push('hash_mismatch');
  }

  return failures.length === 0 ? { pass: true, diagnosis: 'all_checks_pass' }
    : { pass: false, diagnosis: 'hash_mismatch (opaque)' };
}

// ═══════════════════════════════════════════════════════
// Fault injection
// ═══════════════════════════════════════════════════════

function injectSessionRebinding(honest) {
  const fakeNonce = randomBytes(32).toString('hex');
  return {
    ...honest,
    // SBPP: cd was computed with honest nonce, but we claim fakeNonce
    cd: honest.cd, // proof commits to honest nonce
    nonce: fakeNonce, // auditor sees fakeNonce in receipt
    receiptData: lpEncode(honest.sessionId, fakeNonce, honest.root, honest.pv, honest.epoch),
    receiptSig: signReceipt(lpEncode(honest.sessionId, fakeNonce, honest.root, honest.pv, honest.epoch)),
    // V8: token was signed with honest nonce, but we forge with fakeNonce
    tokenData: v8TokenData(honest.sessionId, fakeNonce, honest.root, honest.targetDrop, honest.pv, honest.epoch),
    tokenSig: signReceipt(v8TokenData(honest.sessionId, fakeNonce, honest.root, honest.targetDrop, honest.pv, honest.epoch)),
    v8cd: honest.v8cd, // proof commits to honest v8cd
  };
}

function injectResultSetTampering(honest) {
  const fakeRoot = sha256('tampered-root');
  return {
    ...honest,
    cd: honest.cd,
    root: fakeRoot,
    receiptData: lpEncode(honest.sessionId, honest.nonce, fakeRoot, honest.pv, honest.epoch),
    receiptSig: signReceipt(lpEncode(honest.sessionId, honest.nonce, fakeRoot, honest.pv, honest.epoch)),
    // V8
    tokenData: v8TokenData(honest.sessionId, honest.nonce, fakeRoot, honest.targetDrop, honest.pv, honest.epoch),
    tokenSig: signReceipt(v8TokenData(honest.sessionId, honest.nonce, fakeRoot, honest.targetDrop, honest.pv, honest.epoch)),
    v8cd: honest.v8cd,
  };
}

function injectFabricatedContext(honest) {
  // Forge receipt with wrong key
  const { privateKey: fakeKey } = generateKeyPairSync('ed25519');
  const fakeSig = sign(null, Buffer.from(honest.receiptData), fakeKey);
  const fakeTokenSig = sign(null, Buffer.from(honest.tokenData), fakeKey);
  return {
    ...honest,
    receiptSig: fakeSig,
    tokenSig: fakeTokenSig,
    v8cd: honest.v8cd,
  };
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════

const N_TRIALS = 100;
const results = {
  timestamp: new Date().toISOString(),
  trials: N_TRIALS,
  faults: {},
};

for (const [faultName, injector] of [
  ['session_rebinding', injectSessionRebinding],
  ['result_set_tampering', injectResultSetTampering],
  ['fabricated_context', injectFabricatedContext],
]) {
  let sbppDiagnoses = {};
  let v8Diagnoses = {};

  for (let i = 0; i < N_TRIALS; i++) {
    const honest = createHonestSession();
    const tampered = injector(honest);

    const sbppResult = sbppAudit(tampered);
    const v8Result = v8Audit(tampered);

    sbppDiagnoses[sbppResult.diagnosis] = (sbppDiagnoses[sbppResult.diagnosis] || 0) + 1;
    v8Diagnoses[v8Result.diagnosis] = (v8Diagnoses[v8Result.diagnosis] || 0) + 1;
  }

  results.faults[faultName] = {
    sbpp: sbppDiagnoses,
    v8: v8Diagnoses,
  };
}

// Honest baseline
let sbppPass = 0, v8Pass = 0;
for (let i = 0; i < N_TRIALS; i++) {
  const honest = createHonestSession();
  if (sbppAudit(honest).pass) sbppPass++;
  if (v8Audit(honest).pass) v8Pass++;
}
results.honest_baseline = { sbpp_pass: sbppPass, v8_pass: v8Pass, trials: N_TRIALS };

console.log(JSON.stringify(results, null, 2));
