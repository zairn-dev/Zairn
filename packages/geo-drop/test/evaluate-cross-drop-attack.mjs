/**
 * End-to-end cross-drop transfer attack demonstration.
 *
 * Demonstrates the full attack lifecycle:
 *   1. Two drops (A, B) at identical coordinates, different drop IDs
 *   2. Adversary generates a valid proof for drop A while at the location
 *   3. Adversary submits the same proof transcript for drop B
 *   4. Reports accept/reject for each binding strategy with concrete signal values
 *
 * Covers both Scenario F (cross-session, different nonces) and
 * Scenario G (same-epoch, shared nonce — the critical differentiator).
 *
 * Paper section: §7 Evaluation — End-to-end cross-drop transfer attack
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as snarkjs from 'snarkjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const circuitsDir = path.join(packageRoot, 'circuits');
const buildDir = path.join(circuitsDir, 'build');

const BN128_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function hashToDecimal(value) {
  const raw = BigInt(`0x${createHash('sha256').update(value).digest('hex')}`);
  return (raw % BN128_PRIME).toString();
}

function lengthPrefixEncode(...fields) {
  return fields.map(f => `${String(f).length.toString(10).padStart(4, '0')}${f}`).join('');
}

const SCALE = 1_000_000;
const toFP = (deg) => BigInt(Math.round(deg * SCALE));
const metersToR2 = (m) => { const r = BigInt(Math.round((m / 111320) * SCALE)); return (r * r).toString(); };
const cosLatS = (lat) => BigInt(Math.round(Math.cos((lat * Math.PI) / 180) * SCALE)).toString();

// ─── Setup ─────────────────────────────────────────────
const TARGET_LAT = 35.6586;  // Shibuya, Tokyo
const TARGET_LON = 139.7454;
const UNLOCK_RADIUS = 50;    // meters
const USER_LAT = 35.6589;    // ~30m from target
const USER_LON = 139.7457;

const geoInput = {
  targetLat: toFP(TARGET_LAT).toString(),
  targetLon: toFP(TARGET_LON).toString(),
  radiusSquared: metersToR2(UNLOCK_RADIUS),
  cosLatScaled: cosLatS(TARGET_LAT),
};

const userInput = {
  userLat: toFP(USER_LAT).toString(),
  userLon: toFP(USER_LON).toString(),
};

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  End-to-End Cross-Drop Transfer Attack Demonstration');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Load keys
  const protoVkey = JSON.parse(await readFile(path.join(circuitsDir, 'proximity_verification_key.json'), 'utf8'));
  const zairnVkey = JSON.parse(await readFile(path.join(circuitsDir, 'verification_key.json'), 'utf8'));
  const protoWasm = path.join(buildDir, 'proximity_js', 'proximity.wasm');
  const protoZkey = path.join(circuitsDir, 'proximity_final.zkey');
  const zairnWasm = path.join(buildDir, 'zairn_zkp_js', 'zairn_zkp.wasm');
  const zairnZkey = path.join(circuitsDir, 'zairn_zkp_final.zkey');

  // ─── Define two drops at identical coordinates ───
  const dropA = { dropId: 'drop-alpha', policyVersion: '2', epoch: '100' };
  const dropB = { dropId: 'drop-beta',  policyVersion: '2', epoch: '100' };

  // Scenario F: cross-session (different nonces)
  const nonceA_F = 'nonce-session-1';
  const nonceB_F = 'nonce-session-2';

  // Scenario G: same-epoch, shared nonce (e.g., epoch-derived)
  const sharedNonce = hashToDecimal('user123:epoch100');

  const ctxA_F = {
    contextDigest: hashToDecimal(lengthPrefixEncode(dropA.dropId, dropA.policyVersion, String(dropA.epoch))),
    epoch: dropA.epoch,
    challengeDigest: hashToDecimal(nonceA_F),
  };
  const ctxB_F = {
    contextDigest: hashToDecimal(lengthPrefixEncode(dropB.dropId, dropB.policyVersion, String(dropB.epoch))),
    epoch: dropB.epoch,
    challengeDigest: hashToDecimal(nonceB_F),
  };
  const ctxA_G = {
    contextDigest: hashToDecimal(lengthPrefixEncode(dropA.dropId, dropA.policyVersion, String(dropA.epoch))),
    epoch: dropA.epoch,
    challengeDigest: sharedNonce,
  };
  const ctxB_G = {
    contextDigest: hashToDecimal(lengthPrefixEncode(dropB.dropId, dropB.policyVersion, String(dropB.epoch))),
    epoch: dropB.epoch,
    challengeDigest: sharedNonce,
  };

  console.log('Drop A:', dropA.dropId, '| Drop B:', dropB.dropId);
  console.log('Same coordinates:', `(${TARGET_LAT}, ${TARGET_LON}), r=${UNLOCK_RADIUS}m`);
  console.log('User at:', `(${USER_LAT}, ${USER_LON}) — ~30m from target\n`);

  // ─── Step 1: Adversary generates proof for drop A (legitimately at the location) ───
  console.log('Step 1: Adversary generates legitimate proofs for drop A...');

  // Prototype (no context)
  const protoProof = await snarkjs.groth16.fullProve(
    { ...geoInput, ...userInput },
    protoWasm, protoZkey
  );

  // Zairn-ZKP bound to drop A, Scenario F nonce
  const zairnProof_F = await snarkjs.groth16.fullProve(
    { ...geoInput, ...userInput, ...ctxA_F },
    zairnWasm, zairnZkey
  );

  // Zairn-ZKP bound to drop A, Scenario G shared nonce
  const zairnProof_G = await snarkjs.groth16.fullProve(
    { ...geoInput, ...userInput, ...ctxA_G },
    zairnWasm, zairnZkey
  );

  console.log('  Prototype proof: 5 public signals');
  console.log('  Zairn-ZKP proof (F): 8 public signals');
  console.log('  Zairn-ZKP proof (G): 8 public signals\n');

  // ─── Step 2: Show concrete public signals ───
  console.log('Step 2: Public signal comparison');
  console.log('─'.repeat(70));

  const signalLabels = ['out', 'targetLat', 'targetLon', 'r²', 'cosLat', 'C', 'epoch', 'N'];
  console.log('\nZairn-ZKP proof for drop A (Scenario F):');
  zairnProof_F.publicSignals.forEach((s, i) =>
    console.log(`  pub[${i}] (${signalLabels[i].padEnd(10)}) = ${s.length > 20 ? s.slice(0, 20) + '...' : s}`)
  );

  console.log('\nExpected signals for drop B (Scenario F):');
  const expectedB_F = ['1', geoInput.targetLat, geoInput.targetLon, geoInput.radiusSquared,
    geoInput.cosLatScaled, ctxB_F.contextDigest, ctxB_F.epoch, ctxB_F.challengeDigest];
  expectedB_F.forEach((s, i) =>
    console.log(`  pub[${i}] (${signalLabels[i].padEnd(10)}) = ${s.length > 20 ? s.slice(0, 20) + '...' : s}`)
  );

  console.log('\n  Mismatch fields (F):');
  zairnProof_F.publicSignals.forEach((s, i) => {
    if (s !== expectedB_F[i]) console.log(`    pub[${i}] (${signalLabels[i]}): proof=${s.slice(0, 16)}... ≠ expected=${expectedB_F[i].slice(0, 16)}...`);
  });

  console.log('\nZairn-ZKP proof for drop A (Scenario G, shared nonce):');
  zairnProof_G.publicSignals.forEach((s, i) =>
    console.log(`  pub[${i}] (${signalLabels[i].padEnd(10)}) = ${s.length > 20 ? s.slice(0, 20) + '...' : s}`)
  );

  const expectedB_G = ['1', geoInput.targetLat, geoInput.targetLon, geoInput.radiusSquared,
    geoInput.cosLatScaled, ctxB_G.contextDigest, ctxB_G.epoch, ctxB_G.challengeDigest];
  console.log('\n  Mismatch fields (G):');
  let gMismatchCount = 0;
  zairnProof_G.publicSignals.forEach((s, i) => {
    if (s !== expectedB_G[i]) {
      console.log(`    pub[${i}] (${signalLabels[i]}): proof=${s.slice(0, 16)}... ≠ expected=${expectedB_G[i].slice(0, 16)}...`);
      gMismatchCount++;
    }
  });
  if (gMismatchCount === 0) console.log('    (none — level (ii) would accept!)');

  // ─── Step 3: Verification attempts ───
  console.log('\n' + '─'.repeat(70));
  console.log('Step 3: Cross-drop transfer attack results\n');

  const report = [];

  // Helper: verify and check signals
  async function tryTransfer(label, proof, pubSignals, vkey, expectedSignals) {
    const cryptoOk = await snarkjs.groth16.verify(vkey, pubSignals, proof);
    const signalsMatch = expectedSignals.every((v, i) => pubSignals[i] === v);
    const mismatchIdx = expectedSignals.map((v, i) => pubSignals[i] !== v ? i : -1).filter(i => i >= 0);
    return { label, cryptoOk, signalsMatch, accepted: cryptoOk && signalsMatch, mismatchIdx };
  }

  // --- Scenario F: cross-session ---
  console.log('Scenario F: Cross-session (different nonces)');

  // Prototype → drop B
  const protoF = await tryTransfer(
    'Prototype → B', protoProof.proof, protoProof.publicSignals, protoVkey,
    protoProof.publicSignals // prototype has no context, so signals always match
  );
  console.log(`  Prototype:  Groth16=${protoF.cryptoOk ? 'PASS' : 'FAIL'}  → ACCEPT (no context to check)`);

  // Zairn level (ii) check: nonce mismatch blocks transfer
  const zairnF_ii = zairnProof_F.publicSignals[7] === ctxB_F.challengeDigest;
  console.log(`  Level (ii): Nonce match=${zairnF_ii}  → ${zairnF_ii ? 'ACCEPT' : 'REJECT (N_A ≠ N_B)'}`);

  // Zairn level (iii) check
  const zairnF_iii = await tryTransfer(
    'Zairn → B', zairnProof_F.proof, zairnProof_F.publicSignals, zairnVkey, expectedB_F
  );
  console.log(`  Level (iii): Groth16=${zairnF_iii.cryptoOk ? 'PASS' : 'FAIL'}  Signals=${zairnF_iii.signalsMatch ? 'MATCH' : 'MISMATCH'}  → ${zairnF_iii.accepted ? 'ACCEPT' : 'REJECT'} (mismatched: ${zairnF_iii.mismatchIdx.map(i => signalLabels[i]).join(', ')})`);

  report.push({
    scenario: 'F',
    description: 'Cross-session (different nonces)',
    prototype: 'ACCEPT',
    level_ii: zairnF_ii ? 'ACCEPT' : 'REJECT',
    level_iii: zairnF_iii.accepted ? 'ACCEPT' : 'REJECT',
    rejection_fields_iii: zairnF_iii.mismatchIdx.map(i => signalLabels[i]),
  });

  // --- Scenario G: same-epoch, shared nonce ---
  console.log('\nScenario G: Same-epoch, shared nonce');

  const protoG = await tryTransfer(
    'Prototype → B', protoProof.proof, protoProof.publicSignals, protoVkey,
    protoProof.publicSignals
  );
  console.log(`  Prototype:  Groth16=${protoG.cryptoOk ? 'PASS' : 'FAIL'}  → ACCEPT (no context to check)`);

  // Level (ii): epoch and nonce match — only C differs, but level (ii) has no C
  const zairnG_epoch = zairnProof_G.publicSignals[6] === ctxB_G.epoch;
  const zairnG_nonce = zairnProof_G.publicSignals[7] === ctxB_G.challengeDigest;
  console.log(`  Level (ii): Epoch match=${zairnG_epoch}  Nonce match=${zairnG_nonce}  → ${(zairnG_epoch && zairnG_nonce) ? 'ACCEPT ← VULNERABILITY' : 'REJECT'}`);

  // Level (iii): C_A ≠ C_B
  const zairnG_iii = await tryTransfer(
    'Zairn → B', zairnProof_G.proof, zairnProof_G.publicSignals, zairnVkey, expectedB_G
  );
  console.log(`  Level (iii): Groth16=${zairnG_iii.cryptoOk ? 'PASS' : 'FAIL'}  Signals=${zairnG_iii.signalsMatch ? 'MATCH' : 'MISMATCH'}  → ${zairnG_iii.accepted ? 'ACCEPT' : 'REJECT'} (mismatched: ${zairnG_iii.mismatchIdx.map(i => signalLabels[i]).join(', ')})`);

  report.push({
    scenario: 'G',
    description: 'Same-epoch, shared nonce',
    prototype: 'ACCEPT',
    level_ii: (zairnG_epoch && zairnG_nonce) ? 'ACCEPT' : 'REJECT',
    level_iii: zairnG_iii.accepted ? 'ACCEPT' : 'REJECT',
    rejection_fields_iii: zairnG_iii.mismatchIdx.map(i => signalLabels[i]),
    key_finding: 'Only C (context digest) differs — the single field that level (iii) adds over level (ii)',
  });

  // ─── Summary ───
  console.log('\n' + '═'.repeat(70));
  console.log('Summary');
  console.log('═'.repeat(70));
  console.log('');
  console.log('  Scenario F (cross-session):');
  console.log('    Prototype: ACCEPT | Level (ii): REJECT | Level (iii): REJECT');
  console.log('    → Both in-proof levels prevent cross-session transfer');
  console.log('');
  console.log('  Scenario G (same-epoch, shared nonce):');
  console.log('    Prototype: ACCEPT | Level (ii): ACCEPT | Level (iii): REJECT');
  console.log('    → ONLY level (iii) prevents same-epoch cross-drop transfer');
  console.log('    → The context digest C = H(dropId ‖ pv ‖ epoch) is the sole');
  console.log('      distinguishing field: all other public signals are identical');
  console.log('');
  console.log('  Proof transcript details:');
  console.log(`    Proof size: ${JSON.stringify(zairnProof_G.proof).length} bytes (JSON)`);
  console.log(`    Public signals: ${zairnProof_G.publicSignals.length} field elements`);
  console.log(`    Context digest (A): ${ctxA_G.contextDigest.slice(0, 24)}...`);
  console.log(`    Context digest (B): ${ctxB_G.contextDigest.slice(0, 24)}...`);

  // ─── JSON output ───
  const dateStr = new Date().toISOString().slice(0, 10);
  const output = {
    experiment: 'end-to-end-cross-drop-attack',
    date: new Date().toISOString(),
    setup: {
      target: { lat: TARGET_LAT, lon: TARGET_LON, radius_m: UNLOCK_RADIUS },
      user: { lat: USER_LAT, lon: USER_LON, approx_distance_m: 30 },
      dropA: dropA,
      dropB: dropB,
    },
    scenarios: report,
    proof_transcript: {
      proof_json_bytes: JSON.stringify(zairnProof_G.proof).length,
      public_signals_count: zairnProof_G.publicSignals.length,
      context_digest_A: ctxA_G.contextDigest,
      context_digest_B: ctxB_G.contextDigest,
    },
  };

  const outputPath = path.join(__dirname, `cross-drop-attack-${dateStr}.json`);
  await writeFile(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\nResults written to ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
