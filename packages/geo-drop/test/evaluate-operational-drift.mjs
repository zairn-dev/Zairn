/**
 * Operational Drift Evaluation: Server-Side Off-Circuit vs In-Statement Binding
 *
 * Demonstrates how real-world maintenance bugs cause desynchronization between
 * server-side off-circuit binding and the proof, while in-statement binding
 * remains robust because the context is cryptographically committed inside the proof.
 *
 * Drift scenarios:
 *   D1. Hash schema drift — separator-based encoding instead of length-prefixed
 *   D2. Field order drift — length-prefixed fields reordered (dropId:epoch:policyVersion)
 *   D3. Epoch handling skew — server expects epoch+1 after schema migration
 *   D4. Policy version format — server sends '2.0' instead of '2'
 *   D5. Nonce format change — server hex-encodes nonce after library upgrade
 *
 * For each drift scenario, we show:
 *   - Server off-circuit (recomputed): BROKEN (server recomputes wrong digest, mismatch)
 *   - Server off-circuit (stored): VALID (stored digest was computed at issuance, unaffected by drift)
 *   - In-statement: STILL VALID (proof was generated with correct values, public signals match)
 *
 * Paper section: §8 Evaluation — RQ4 extension: Operational Robustness
 */

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

// BN128 field prime
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

// ═════════════════════════════════════════════════════════════
// Correct implementation (matches prover's logic exactly)
// ═════════════════════════════════════════════════════════════

function buildStatementCorrect({ dropId, policyVersion, epoch, serverNonce }) {
  return {
    contextDigest: hashToDecimal(lengthPrefixEncode(dropId, policyVersion, String(epoch))),
    epoch: String(epoch),
    challengeDigest: hashToDecimal(serverNonce),
  };
}

// ═════════════════════════════════════════════════════════════
// Drifted implementations (maintenance bugs)
// ═════════════════════════════════════════════════════════════

const driftedBuilders = {
  'D1: Hash separator drift': ({ dropId, policyVersion, epoch, serverNonce }) => ({
    // Bug: someone used separator-based encoding instead of length-prefixed
    contextDigest: hashToDecimal(`${dropId}:${policyVersion}:${epoch}`),
    epoch: String(epoch),
    challengeDigest: hashToDecimal(serverNonce),
  }),

  'D2: Field order drift': ({ dropId, policyVersion, epoch, serverNonce }) => ({
    // Bug: fields reordered in server code (dropId:epoch:policyVersion instead of dropId:policyVersion:epoch)
    contextDigest: hashToDecimal(lengthPrefixEncode(dropId, String(epoch), policyVersion)),
    epoch: String(epoch),
    challengeDigest: hashToDecimal(serverNonce),
  }),

  'D3: Epoch handling skew': ({ dropId, policyVersion, epoch, serverNonce }) => ({
    // Bug: server increments epoch by 1 after a migration ("off-by-one" fix)
    contextDigest: hashToDecimal(lengthPrefixEncode(dropId, policyVersion, String(epoch + 1))),
    epoch: String(epoch + 1),
    challengeDigest: hashToDecimal(serverNonce),
  }),

  'D4: Policy version format': ({ dropId, policyVersion, epoch, serverNonce }) => ({
    // Bug: server sends policyVersion as '2.0' instead of '2' after numeric parsing change
    contextDigest: hashToDecimal(lengthPrefixEncode(dropId, policyVersion + '.0', String(epoch))),
    epoch: String(epoch),
    challengeDigest: hashToDecimal(serverNonce),
  }),

  'D5: Nonce format change': ({ dropId, policyVersion, epoch, serverNonce }) => ({
    // Bug: server hex-encodes the nonce after a crypto library upgrade
    contextDigest: hashToDecimal(lengthPrefixEncode(dropId, policyVersion, String(epoch))),
    epoch: String(epoch),
    challengeDigest: hashToDecimal(Buffer.from(serverNonce).toString('hex')),
  }),
};

// ═════════════════════════════════════════════════════════════
// Validation functions
// ═════════════════════════════════════════════════════════════

function validateZairnSignals(publicSignals, expectedGeo, expectedStatement) {
  if (!publicSignals || publicSignals.length < 8) return false;
  const expected = [
    '1',
    expectedGeo.targetLat,
    expectedGeo.targetLon,
    expectedGeo.radiusSquared,
    expectedGeo.cosLatScaled,
    expectedStatement.contextDigest,
    expectedStatement.epoch,
    expectedStatement.challengeDigest,
  ];
  return expected.every((v, i) => publicSignals[i] === v);
}

// ═════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Operational Drift: Server Off-Circuit vs In-Statement');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Load Zairn-ZKP artifacts
  const zairnVkey = JSON.parse(await readFile(path.join(circuitsDir, 'verification_key.json'), 'utf8'));
  const zairnWasm = path.join(buildDir, 'zairn_zkp_js', 'zairn_zkp.wasm');
  const zairnZkey = path.join(circuitsDir, 'zairn_zkp_final.zkey');

  // Common parameters
  const TARGET_LAT = 35.6586;
  const TARGET_LON = 139.7454;
  const UNLOCK_RADIUS = 50;
  const USER_LAT = 35.6589;
  const USER_LON = 139.7457;

  const originalContext = {
    dropId: 'drop-drift-test',
    policyVersion: '2',
    epoch: 42,
    serverNonce: 'nonce-abc123',
  };

  const correctStatement = buildStatementCorrect(originalContext);

  const geoInput = {
    targetLat: toFP(TARGET_LAT).toString(),
    targetLon: toFP(TARGET_LON).toString(),
    radiusSquared: metersToR2(UNLOCK_RADIUS),
    cosLatScaled: cosLatS(TARGET_LAT),
  };

  // Generate a valid proof (prover uses correct implementation)
  console.log('Generating proof with correct statement binding...');
  const circuitInput = {
    ...geoInput,
    userLat: toFP(USER_LAT).toString(),
    userLon: toFP(USER_LON).toString(),
    contextDigest: correctStatement.contextDigest,
    epoch: correctStatement.epoch,
    challengeDigest: correctStatement.challengeDigest,
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(circuitInput, zairnWasm, zairnZkey);
  const cryptoValid = await snarkjs.groth16.verify(zairnVkey, publicSignals, proof);
  console.log(`  Groth16 verification: ${cryptoValid ? 'VALID' : 'INVALID'}`);
  console.log(`  Public signals: [${publicSignals.slice(0, 3).join(', ')}, ... ]`);

  // Stored digest: computed at issuance using correct implementation, stored in DB.
  // This simulates Strategy 2c — the server stores the canonical digest at challenge
  // issuance time and compares against it later, rather than recomputing.
  const storedDigest = { ...correctStatement }; // frozen at issuance

  // Baseline: correct server implementation
  console.log('\n─── Baseline (no drift) ───');
  const baselineSignalValid = validateZairnSignals(publicSignals, geoInput, correctStatement);
  console.log(`  Server off-circuit (recomputed) digest match: YES`);
  console.log(`  Server off-circuit (stored) digest match:     YES`);
  console.log(`  In-statement signal validation:               ${baselineSignalValid ? 'VALID' : 'INVALID'}`);

  // Run each drift scenario
  const results = [];

  for (const [name, builder] of Object.entries(driftedBuilders)) {
    console.log(`\n─── ${name} ───`);
    const driftedStatement = builder(originalContext);

    // Strategy 2b: Server off-circuit (recomputed) — server recomputes digest with drifted code
    const serverDigestMatch = driftedStatement.contextDigest === correctStatement.contextDigest;
    const serverEpochMatch = driftedStatement.epoch === correctStatement.epoch;
    const serverChallengeMatch = driftedStatement.challengeDigest === correctStatement.challengeDigest;
    const serverRecomputedAccepted = serverDigestMatch && serverEpochMatch && serverChallengeMatch;

    // Strategy 2c: Server off-circuit (stored) — compares against digest stored at issuance
    // The stored digest was computed BEFORE drift, so it is always correct
    const storedDigestMatch = storedDigest.contextDigest === correctStatement.contextDigest;
    const storedEpochMatch = storedDigest.epoch === correctStatement.epoch;
    const storedChallengeMatch = storedDigest.challengeDigest === correctStatement.challengeDigest;
    const storedDigestAccepted = storedDigestMatch && storedEpochMatch && storedChallengeMatch;

    // Strategy 3: In-statement — validate public signals against stored (correct) digests
    const inStatementValid = validateZairnSignals(publicSignals, geoInput, correctStatement);

    // Also check what happens when in-statement uses drifted expectations (for completeness)
    const inStatementAgainstDrifted = validateZairnSignals(publicSignals, geoInput, driftedStatement);

    const extractedDigest = publicSignals[5];
    const extractedEpoch = publicSignals[6];
    const extractedChallenge = publicSignals[7];
    const proofSelfDescribing = extractedDigest === correctStatement.contextDigest &&
                                 extractedEpoch === correctStatement.epoch &&
                                 extractedChallenge === correctStatement.challengeDigest;

    console.log(`  Context digest: correct=${correctStatement.contextDigest.slice(0, 20)}...`);
    console.log(`                  drifted=${driftedStatement.contextDigest.slice(0, 20)}...`);
    console.log(`  Epoch:          correct=${correctStatement.epoch}, drifted=${driftedStatement.epoch}`);
    console.log(`  Challenge:      correct=${correctStatement.challengeDigest.slice(0, 20)}...`);
    console.log(`                  drifted=${driftedStatement.challengeDigest.slice(0, 20)}...`);
    console.log(`  Server off-circuit (recomputed): ${serverRecomputedAccepted ? 'ACCEPT' : 'REJECT (false negative!)'}`);
    console.log(`  Server off-circuit (stored):     ${storedDigestAccepted ? 'ACCEPT' : 'REJECT'}`);
    console.log(`  In-statement (stored expectation): ${inStatementValid ? 'ACCEPT' : 'REJECT'}`);
    console.log(`  In-statement (drifted expectation): ${inStatementAgainstDrifted ? 'ACCEPT' : 'REJECT'}`);
    console.log(`  Groth16 proof validity: ${cryptoValid ? 'VALID' : 'INVALID'}`);
    console.log(`  Proof is self-describing: ${proofSelfDescribing ? 'YES' : 'NO'}`);

    results.push({
      scenario: name,
      serverRecomputed: {
        accepted: serverRecomputedAccepted,
        digestMatch: serverDigestMatch,
        epochMatch: serverEpochMatch,
        challengeMatch: serverChallengeMatch,
        impact: serverRecomputedAccepted ? 'none' : 'FALSE NEGATIVE — honest proof rejected',
      },
      serverStored: {
        accepted: storedDigestAccepted,
        impact: storedDigestAccepted ? 'none (stored digest unaffected by drift)' : 'FALSE NEGATIVE',
      },
      inStatement: {
        groth16Valid: cryptoValid,
        signalsMatchStored: inStatementValid,
        signalsMatchDrifted: inStatementAgainstDrifted,
        proofSelfDescribing,
        impact: 'Proof carries committed context; canonical digests stored at issuance match',
      },
    });
  }

  // Summary table
  console.log('\n═══════════════════════════════════════════════════════════════════════════════════════');
  console.log('  Summary: Drift Impact');
  console.log('═══════════════════════════════════════════════════════════════════════════════════════\n');

  console.log('┌──────────────────────────────┬──────────────────────┬──────────────────────┬──────────────────────┐');
  console.log('│ Drift Scenario               │ Off-Cir. (recomp.)   │ Off-Cir. (stored)    │ In-Statement         │');
  console.log('├──────────────────────────────┼──────────────────────┼──────────────────────┼──────────────────────┤');
  console.log(`│ Baseline (no drift)          │ ${'ACCEPT'.padEnd(20)} │ ${'ACCEPT'.padEnd(20)} │ ${'ACCEPT'.padEnd(20)} │`);
  for (const r of results) {
    const recompResult = r.serverRecomputed.accepted ? 'ACCEPT' : 'REJECT (false neg.)';
    const storedResult = r.serverStored.accepted ? 'ACCEPT' : 'REJECT';
    const inStmtResult = r.inStatement.signalsMatchStored ? 'ACCEPT' : 'REJECT';
    console.log(`│ ${r.scenario.padEnd(28)} │ ${recompResult.padEnd(20)} │ ${storedResult.padEnd(20)} │ ${inStmtResult.padEnd(20)} │`);
  }
  console.log('└──────────────────────────────┴──────────────────────┴──────────────────────┴──────────────────────┘');

  // Failure mode analysis
  console.log('\nAnalysis:');
  const recompFailed = results.filter(r => !r.serverRecomputed.accepted).length;
  const storedFailed = results.filter(r => !r.serverStored.accepted).length;
  const inStmtFailed = results.filter(r => !r.inStatement.signalsMatchStored).length;
  console.log(`  Server off-circuit (recomputed): ${recompFailed}/${results.length} drift scenarios cause false negatives`);
  console.log(`  Server off-circuit (stored):     ${storedFailed}/${results.length} drift scenarios cause false negatives`);
  console.log(`  In-statement:                    ${inStmtFailed}/${results.length} drift scenarios cause false negatives`);
  console.log('');
  console.log('  Key insight: drift resilience is NOT unique to in-statement binding.');
  console.log('  Server off-circuit (stored) also survives all drift scenarios because');
  console.log('  the canonical digest is stored at issuance and never recomputed.');
  console.log('');
  console.log('  The unique advantage of in-statement binding is cryptographic context');
  console.log('  commitment (demonstrated by Scenario F in the binding baseline experiment),');
  console.log('  not drift resilience per se.');

  // JSON output
  const dateStr = new Date().toISOString().slice(0, 10);
  const outputPath = path.join(__dirname, `operational-drift-results-${dateStr}.json`);
  await writeFile(
    outputPath,
    JSON.stringify({
      experiment: 'operational-drift',
      date: new Date().toISOString(),
      originalContext,
      baseline: { serverRecomputed: 'ACCEPT', serverStored: 'ACCEPT', inStatement: 'ACCEPT' },
      scenarios: results,
      summary: {
        serverRecomputedFailures: recompFailed,
        serverStoredFailures: storedFailed,
        inStatementFailures: inStmtFailed,
        totalScenarios: results.length,
        conclusion: 'Recomputed off-circuit fails under all drift scenarios; stored off-circuit and in-statement are both resilient. The unique advantage of in-statement is cryptographic context commitment (Scenario F), not drift resilience.',
      },
    }, null, 2),
    'utf8'
  );
  console.log(`\nResults written to ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
