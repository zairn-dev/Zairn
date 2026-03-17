/**
 * Off-Circuit Binding Baseline Experiment
 *
 * Compares five verification strategies across six attack scenarios
 * to demonstrate why in-statement context binding (Zairn-ZKP) is necessary.
 *
 * Strategies:
 *   1.  No binding (prototype circuit) — Groth16 verify only, context ignored
 *   2a. Off-circuit binding (client) — Groth16 verify + application-level context check (prototype circuit)
 *   2b. Off-circuit binding (server, recomputed) — Server recomputes expected digests
 *   2c. Off-circuit binding (server, stored) — Server stores canonical digest at issuance, compares claim
 *   3.  In-statement binding (Zairn-ZKP) — Groth16 verify with context in public signals
 *
 * Scenarios:
 *   A. Honest unlock
 *   B. Cross-drop replay (naive — attacker submits original context)
 *   C. Stale epoch reuse
 *   D. Application bypass (middleware skips context check)
 *   E. Signal tampering
 *   F. Coordinate-identical cross-drop (smart — attacker submits correct context for target drop)
 *
 * Paper section: §7.2 — Verification Strategy Comparison
 */

import { performance } from 'node:perf_hooks';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const circuitsDir = path.join(packageRoot, 'circuits');
const buildDir = path.join(circuitsDir, 'build');

// ─── Helpers ───────────────────────────────────────────────

// BN128 field prime — snarkjs reduces all inputs modulo this value
const BN128_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function hashToDecimal(value) {
  const digest = createHash('sha256').update(value).digest('hex');
  const raw = BigInt(`0x${digest}`);
  return (raw % BN128_PRIME).toString();
}

function lengthPrefixEncode(...fields) {
  return fields.map(f => `${String(f).length.toString(10).padStart(4, '0')}${f}`).join('');
}

function buildStatement({ dropId, policyVersion = '1', epoch, serverNonce }) {
  return {
    contextDigest: hashToDecimal(lengthPrefixEncode(dropId, policyVersion, String(epoch))),
    epoch: String(epoch),
    challengeDigest: hashToDecimal(serverNonce),
  };
}

const SCALE = 1_000_000;
const toFixedPoint = (deg) => BigInt(Math.round(deg * SCALE));
const metersToRadiusSquared = (m) => {
  const rFp = BigInt(Math.round((m / 111320) * SCALE));
  return (rFp * rFp).toString();
};
const cosLatScaled = (lat) =>
  BigInt(Math.round(Math.cos((lat * Math.PI) / 180) * SCALE)).toString();

// ─── Off-circuit context check (simulates application-level validation) ───

function offCircuitContextCheck(storedContext, claimedContext) {
  return (
    storedContext.dropId === claimedContext.dropId &&
    storedContext.policyVersion === claimedContext.policyVersion &&
    String(storedContext.epoch) === String(claimedContext.epoch) &&
    storedContext.serverNonce === claimedContext.serverNonce
  );
}

// ─── Zairn-ZKP signal validation (mirrors src/zkp.ts validatePublicSignals) ───

function validateZairnSignals(publicSignals, expectedInput, expectedStatement) {
  if (!publicSignals || publicSignals.length < 8) return false;
  const expected = [
    '1',
    expectedInput.targetLat,
    expectedInput.targetLon,
    expectedInput.radiusSquared,
    expectedInput.cosLatScaled,
    expectedStatement.contextDigest,
    expectedStatement.epoch,
    expectedStatement.challengeDigest,
  ];
  return expected.every((v, i) => publicSignals[i] === v);
}

// ─── Off-circuit stored-digest check (compares attacker's claimed context against stored canonical) ───

function offCircuitStoredDigestCheck(storedDigest, claimedDigest) {
  return (
    storedDigest.contextDigest === claimedDigest.contextDigest &&
    storedDigest.epoch === claimedDigest.epoch &&
    storedDigest.challengeDigest === claimedDigest.challengeDigest
  );
}

// ─── Five-strategy verify ───────────────────────────────

async function fiveStrategyVerify({
  proof,
  publicSignals,
  vkey,
  circuitType,
  verifierContext,
  originalContext,
  claimedContext,    // what the attacker claims (may differ from originalContext)
  storedDigest,      // canonical digest stored by backend at issuance (for Strategy 2c)
  geoInput,
  bypassAppCheck,
}) {
  // Strategy 1: No binding — just Groth16 verify
  const cryptoValid = await snarkjs.groth16.verify(vkey, publicSignals, proof);

  // Strategy 2a: Off-circuit binding (client) — Groth16 verify + app-level context match
  let offCircuitResult;
  if (!cryptoValid) {
    offCircuitResult = { accepted: false, reason: 'Groth16 rejected' };
  } else if (bypassAppCheck) {
    offCircuitResult = { accepted: true, reason: 'App check bypassed' };
  } else {
    const contextMatch = offCircuitContextCheck(verifierContext, claimedContext);
    offCircuitResult = {
      accepted: contextMatch,
      reason: contextMatch ? 'Context matched' : 'Context mismatch (app-level)',
    };
  }

  // Strategy 2b: Server-side off-circuit (recomputed) — server recomputes expected digests
  let serverOffCircuitResult;
  if (!cryptoValid) {
    serverOffCircuitResult = { accepted: false, reason: 'Groth16 rejected' };
  } else {
    const contextMatch = offCircuitContextCheck(verifierContext, claimedContext);
    serverOffCircuitResult = {
      accepted: contextMatch,
      reason: contextMatch ? 'Context matched (server)' : 'Context mismatch (server-side)',
    };
  }

  // Strategy 2c: Server-side off-circuit (stored digest) — compares claimed digest against stored canonical
  let storedDigestResult;
  if (!cryptoValid) {
    storedDigestResult = { accepted: false, reason: 'Groth16 rejected' };
  } else {
    const claimedDigestObj = buildStatement(claimedContext);
    const digestMatch = offCircuitStoredDigestCheck(storedDigest, claimedDigestObj);
    storedDigestResult = {
      accepted: digestMatch,
      reason: digestMatch ? 'Stored digest matched' : 'Stored digest mismatch',
    };
  }

  // Strategy 3: In-statement binding — Groth16 verify + signal validation
  let inStatementResult;
  if (circuitType === 'prototype') {
    // Prototype has no context signals; always "passes" signal check vacuously
    // but cannot detect context mismatch
    inStatementResult = {
      accepted: cryptoValid,
      reason: cryptoValid ? 'No context signals to check' : 'Groth16 rejected',
    };
  } else {
    // Zairn-ZKP: validate public signals against verifier's expected context
    const verifierStatement = buildStatement(verifierContext);
    const signalValid = validateZairnSignals(publicSignals, geoInput, verifierStatement);
    if (!cryptoValid) {
      inStatementResult = { accepted: false, reason: 'Groth16 rejected' };
    } else if (!signalValid) {
      inStatementResult = { accepted: false, reason: 'Signal mismatch (cryptographic)' };
    } else {
      inStatementResult = { accepted: true, reason: 'Proof + signals valid' };
    }
  }

  return {
    noBinding: { accepted: cryptoValid, reason: cryptoValid ? 'Groth16 passed' : 'Groth16 rejected' },
    offCircuit: offCircuitResult,
    serverOffCircuit: serverOffCircuitResult,
    storedDigest: storedDigestResult,
    inStatement: inStatementResult,
  };
}

// ─── Main ───────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Off-Circuit Binding Baseline Experiment');
  console.log('  5 strategies × 6 scenarios');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Load artifacts
  const protoVkey = JSON.parse(
    await readFile(path.join(circuitsDir, 'proximity_verification_key.json'), 'utf8')
  );
  const zairnVkey = JSON.parse(
    await readFile(path.join(circuitsDir, 'verification_key.json'), 'utf8')
  );

  const protoWasm = path.join(buildDir, 'proximity_js', 'proximity.wasm');
  const protoZkey = path.join(circuitsDir, 'proximity_final.zkey');
  const zairnWasm = path.join(buildDir, 'zairn_zkp_js', 'zairn_zkp.wasm');
  const zairnZkey = path.join(circuitsDir, 'zairn_zkp_final.zkey');

  // Common parameters
  const TARGET_LAT = 35.6586;
  const TARGET_LON = 139.7454;
  const UNLOCK_RADIUS = 50;
  const USER_LAT = 35.6589; // ~30m away
  const USER_LON = 139.7457;

  const contextA = {
    dropId: 'drop-alpha',
    policyVersion: '2',
    epoch: 100,
    serverNonce: 'nonce-session-1',
  };

  const contextB = {
    dropId: 'drop-beta',
    policyVersion: '2',
    epoch: 100,
    serverNonce: 'nonce-session-2',
  };

  const contextStale = {
    dropId: 'drop-alpha',
    policyVersion: '2',
    epoch: 999,
    serverNonce: 'nonce-session-old',
  };

  const stmtA = buildStatement(contextA);
  const stmtB = buildStatement(contextB);
  const stmtStale = buildStatement(contextStale);

  const geoInput = {
    targetLat: toFixedPoint(TARGET_LAT).toString(),
    targetLon: toFixedPoint(TARGET_LON).toString(),
    radiusSquared: metersToRadiusSquared(UNLOCK_RADIUS),
    cosLatScaled: cosLatScaled(TARGET_LAT),
  };

  // ─── Generate proofs ───

  console.log('Generating proofs...');
  const t0 = performance.now();

  // Prototype proof (5 public signals)
  const protoInput = {
    ...geoInput,
    userLat: toFixedPoint(USER_LAT).toString(),
    userLon: toFixedPoint(USER_LON).toString(),
  };
  const protoResult = await snarkjs.groth16.fullProve(protoInput, protoWasm, protoZkey);

  // Zairn-ZKP proof (8 public signals, bound to contextA)
  const zairnInput = {
    ...protoInput,
    contextDigest: stmtA.contextDigest,
    epoch: stmtA.epoch,
    challengeDigest: stmtA.challengeDigest,
  };
  const zairnResult = await snarkjs.groth16.fullProve(zairnInput, zairnWasm, zairnZkey);

  console.log(`Proofs generated in ${(performance.now() - t0).toFixed(0)}ms\n`);

  // ─── Run scenarios ───

  const results = [];

  // Scenario A: Honest unlock (verifier expects contextA, proof is for contextA)
  {
    const proto = await fiveStrategyVerify({
      proof: protoResult.proof,
      publicSignals: protoResult.publicSignals,
      vkey: protoVkey,
      circuitType: 'prototype',
      verifierContext: contextA,
      originalContext: contextA,
      claimedContext: contextA,
      storedDigest: stmtA,
      geoInput,
      bypassAppCheck: false,
    });
    const zairn = await fiveStrategyVerify({
      proof: zairnResult.proof,
      publicSignals: zairnResult.publicSignals,
      vkey: zairnVkey,
      circuitType: 'zairn',
      verifierContext: contextA,
      originalContext: contextA,
      claimedContext: contextA,
      storedDigest: stmtA,
      geoInput,
      bypassAppCheck: false,
    });
    results.push({
      scenario: 'A: Honest unlock',
      attack: 'None',
      proto,
      zairn,
    });
  }

  // Scenario B: Cross-drop replay (proof for dropA, verifier expects dropB)
  // Naive attacker: submits original contextA as claim to drop-beta
  {
    const proto = await fiveStrategyVerify({
      proof: protoResult.proof,
      publicSignals: protoResult.publicSignals,
      vkey: protoVkey,
      circuitType: 'prototype',
      verifierContext: contextB,
      originalContext: contextA,
      claimedContext: contextA,
      storedDigest: stmtB,
      geoInput,
      bypassAppCheck: false,
    });
    const zairn = await fiveStrategyVerify({
      proof: zairnResult.proof,
      publicSignals: zairnResult.publicSignals,
      vkey: zairnVkey,
      circuitType: 'zairn',
      verifierContext: contextB,
      originalContext: contextA,
      claimedContext: contextA,
      storedDigest: stmtB,
      geoInput,
      bypassAppCheck: false,
    });
    results.push({
      scenario: 'B: Cross-drop replay',
      attack: 'Proof generated for drop-alpha, submitted to drop-beta (naive claim)',
      proto,
      zairn,
    });
  }

  // Scenario C: Stale epoch reuse
  {
    const proto = await fiveStrategyVerify({
      proof: protoResult.proof,
      publicSignals: protoResult.publicSignals,
      vkey: protoVkey,
      circuitType: 'prototype',
      verifierContext: contextStale,
      originalContext: contextA,
      claimedContext: contextA,
      storedDigest: stmtStale,
      geoInput,
      bypassAppCheck: false,
    });
    const zairn = await fiveStrategyVerify({
      proof: zairnResult.proof,
      publicSignals: zairnResult.publicSignals,
      vkey: zairnVkey,
      circuitType: 'zairn',
      verifierContext: contextStale,
      originalContext: contextA,
      claimedContext: contextA,
      storedDigest: stmtStale,
      geoInput,
      bypassAppCheck: false,
    });
    results.push({
      scenario: 'C: Stale epoch reuse',
      attack: 'Proof from epoch=100, verifier expects epoch=999',
      proto,
      zairn,
    });
  }

  // Scenario D: Application bypass (middleware skips context check)
  {
    const proto = await fiveStrategyVerify({
      proof: protoResult.proof,
      publicSignals: protoResult.publicSignals,
      vkey: protoVkey,
      circuitType: 'prototype',
      verifierContext: contextB,
      originalContext: contextA,
      claimedContext: contextA,
      storedDigest: stmtB,
      geoInput,
      bypassAppCheck: true,
    });
    const zairn = await fiveStrategyVerify({
      proof: zairnResult.proof,
      publicSignals: zairnResult.publicSignals,
      vkey: zairnVkey,
      circuitType: 'zairn',
      verifierContext: contextB,
      originalContext: contextA,
      claimedContext: contextA,
      storedDigest: stmtB,
      geoInput,
      bypassAppCheck: true,
    });
    results.push({
      scenario: 'D: Application bypass',
      attack: 'Cross-drop replay + app-level check disabled',
      proto,
      zairn,
    });
  }

  // Scenario E: Signal tampering (replace contextDigest in public signals)
  {
    const tamperedSignals = [...zairnResult.publicSignals];
    tamperedSignals[5] = stmtB.contextDigest; // replace contextDigest

    const cryptoValid = await snarkjs.groth16.verify(zairnVkey, tamperedSignals, zairnResult.proof);
    results.push({
      scenario: 'E: Signal tampering',
      attack: 'Replace contextDigest in submitted public signals',
      proto: {
        noBinding: { accepted: 'N/A', reason: 'Prototype has no context signals' },
        offCircuit: { accepted: 'N/A', reason: 'N/A' },
        serverOffCircuit: { accepted: 'N/A', reason: 'N/A' },
        storedDigest: { accepted: 'N/A', reason: 'N/A' },
        inStatement: { accepted: 'N/A', reason: 'N/A' },
      },
      zairn: {
        noBinding: { accepted: cryptoValid, reason: cryptoValid ? 'Groth16 passed' : 'Groth16 rejected (soundness)' },
        offCircuit: { accepted: cryptoValid, reason: cryptoValid ? 'Would pass' : 'Groth16 rejected' },
        serverOffCircuit: { accepted: cryptoValid, reason: cryptoValid ? 'Would pass' : 'Groth16 rejected (soundness)' },
        storedDigest: { accepted: cryptoValid, reason: cryptoValid ? 'Would pass' : 'Groth16 rejected (soundness)' },
        inStatement: { accepted: cryptoValid, reason: cryptoValid ? 'Would pass' : 'Groth16 soundness prevents forgery' },
      },
    });
  }

  // Scenario F: Coordinate-identical cross-drop (smart attacker)
  // Two drops at the SAME coordinates but different dropIds.
  // Attacker has valid Zairn proof bound to contextA (drop-alpha).
  // Submits to drop-beta with claimedContext = contextB (smart — claims correct context for target).
  // All off-circuit strategies are fooled; only in-statement detects the mismatch.
  {
    const proto = await fiveStrategyVerify({
      proof: protoResult.proof,
      publicSignals: protoResult.publicSignals,
      vkey: protoVkey,
      circuitType: 'prototype',
      verifierContext: contextB,
      originalContext: contextA,
      claimedContext: contextB,   // smart: claims correct context for drop-beta
      storedDigest: stmtB,
      geoInput,
      bypassAppCheck: false,
    });
    const zairn = await fiveStrategyVerify({
      proof: zairnResult.proof,
      publicSignals: zairnResult.publicSignals,
      vkey: zairnVkey,
      circuitType: 'zairn',
      verifierContext: contextB,
      originalContext: contextA,
      claimedContext: contextB,   // smart: claims correct context for drop-beta
      storedDigest: stmtB,
      geoInput,
      bypassAppCheck: false,
    });
    results.push({
      scenario: 'F: Coord-identical cross-drop',
      attack: 'Proof for drop-alpha, claims drop-beta context (same coords)',
      proto,
      zairn,
    });
  }

  // ─── Print results ───

  console.log('Results');
  console.log('═'.repeat(114));
  console.log(
    'Scenario'.padEnd(30) +
    'Circuit'.padEnd(8) +
    'No Bind'.padEnd(10) +
    'Off-Cir(C)'.padEnd(13) +
    'Off-Cir(S-R)'.padEnd(14) +
    'Off-Cir(S-D)'.padEnd(14) +
    'In-Statement'.padEnd(14)
  );
  console.log('─'.repeat(114));

  for (const r of results) {
    const fmtAccept = (v) => {
      if (v === 'N/A') return 'N/A';
      return v ? 'ACCEPT' : 'REJECT';
    };

    // Prototype row
    console.log(
      r.scenario.padEnd(30) +
      'Proto'.padEnd(8) +
      fmtAccept(r.proto.noBinding.accepted).padEnd(10) +
      fmtAccept(r.proto.offCircuit.accepted).padEnd(13) +
      fmtAccept(r.proto.serverOffCircuit.accepted).padEnd(14) +
      fmtAccept(r.proto.storedDigest.accepted).padEnd(14) +
      fmtAccept(r.proto.inStatement.accepted).padEnd(14)
    );
    // Zairn row
    console.log(
      ''.padEnd(30) +
      'Zairn'.padEnd(8) +
      fmtAccept(r.zairn.noBinding.accepted).padEnd(10) +
      fmtAccept(r.zairn.offCircuit.accepted).padEnd(13) +
      fmtAccept(r.zairn.serverOffCircuit.accepted).padEnd(14) +
      fmtAccept(r.zairn.storedDigest.accepted).padEnd(14) +
      fmtAccept(r.zairn.inStatement.accepted).padEnd(14)
    );
    console.log('─'.repeat(114));
  }

  // ─── Key insight summary ───

  console.log('\nKey findings:');
  console.log('  • Scenario F (coordinate-identical cross-drop) is the critical differentiator.');
  console.log('    A smart attacker claims the correct context for the target drop.');
  console.log('    ALL off-circuit strategies (2a, 2b, 2c) ACCEPT because the claimed');
  console.log('    context is valid for the target drop — the proof carries no');
  console.log('    cryptographic commitment to any specific context.');
  console.log('    Only in-statement binding REJECTS because the proof\'s public signals');
  console.log('    contain C_A (committed at proving time), which differs from C_B.');
  console.log('  • Scenarios B–D show that off-circuit strategies detect naive attacks');
  console.log('    where the attacker does not adapt the claimed context.');
  console.log('  • Strategy 2c (stored digest) is robust to Scenario D (app bypass),');
  console.log('    matching in-statement for that scenario. But Scenario F reveals the');
  console.log('    fundamental limitation: stored-digest checks validate the claim,');
  console.log('    not the proof\'s cryptographic binding.');
  console.log('  • Scenario E confirms signal tampering is rejected by Groth16 soundness.');

  // ─── JSON output ───

  const dateStr = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(__dirname, `off-circuit-baseline-results-${dateStr}.json`);
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        experiment: 'off-circuit-binding-baseline',
        date: new Date().toISOString(),
        strategies: ['no-binding', 'off-circuit-client', 'server-off-circuit-recomputed', 'server-off-circuit-stored', 'in-statement'],
        circuits: ['prototype (5 signals)', 'zairn-zkp (8 signals)'],
        results: results.map((r) => ({
          scenario: r.scenario,
          attack: r.attack,
          prototype: {
            noBinding: r.proto.noBinding,
            offCircuit: r.proto.offCircuit,
            serverOffCircuit: r.proto.serverOffCircuit,
            storedDigest: r.proto.storedDigest,
            inStatement: r.proto.inStatement,
          },
          zairnZkp: {
            noBinding: r.zairn.noBinding,
            offCircuit: r.zairn.offCircuit,
            serverOffCircuit: r.zairn.serverOffCircuit,
            storedDigest: r.zairn.storedDigest,
            inStatement: r.zairn.inStatement,
          },
        })),
      },
      null,
      2
    ),
    'utf8'
  );
  console.log(`\nResults written to ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
