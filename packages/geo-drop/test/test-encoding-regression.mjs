/**
 * Encoding regression test: length-prefixed vs separator-based canonical encoding.
 *
 * Verifies:
 *   1. Old (separator) and new (length-prefixed) encodings produce different digests
 *   2. Length-prefixed encoding is unambiguous for adversarial inputs
 *   3. Context digests are deterministic and reproducible
 */

import { createHash } from 'node:crypto';

const BN128_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function hashToField(value) {
  const raw = BigInt(`0x${createHash('sha256').update(value).digest('hex')}`);
  return (raw % BN128_PRIME).toString();
}

function lengthPrefixEncode(...fields) {
  return fields.map(f => `${String(f).length.toString(10).padStart(4, '0')}${f}`).join('');
}

// Old separator-based encoding (for comparison)
function separatorEncode(dropId, policyVersion, epoch) {
  return `${dropId}:${policyVersion}:${epoch}`;
}

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Encoding Regression Test');
console.log('═══════════════════════════════════════════════════════════════\n');

// Test 1: Old and new encodings produce different digests
console.log('Test 1: Old vs new encoding divergence');
{
  const drop = 'drop-42';
  const pv = '2';
  const epoch = '7';

  const oldEncoded = separatorEncode(drop, pv, epoch);
  const newEncoded = lengthPrefixEncode(drop, pv, epoch);
  const oldDigest = hashToField(oldEncoded);
  const newDigest = hashToField(newEncoded);

  console.log(`  Old encoding: "${oldEncoded}"`);
  console.log(`  New encoding: "${newEncoded}"`);
  assert(oldEncoded !== newEncoded, 'Encoded strings differ');
  assert(oldDigest !== newDigest, 'Digests differ');
}

// Test 2: Length-prefixed is unambiguous for adversarial inputs
console.log('\nTest 2: Ambiguity resistance');
{
  // With separator-based: "a:b" + "c" = "a:b:c" vs "a" + "b:c" = "a:b:c" — SAME!
  const sep1 = separatorEncode('a:b', 'c', 'd');
  const sep2 = separatorEncode('a', 'b:c', 'd');
  assert(sep1 === sep2, 'Separator encoding IS ambiguous (expected)');

  // With length-prefixed: different because lengths differ
  const lp1 = lengthPrefixEncode('a:b', 'c', 'd');
  const lp2 = lengthPrefixEncode('a', 'b:c', 'd');
  assert(lp1 !== lp2, 'Length-prefixed encoding is unambiguous');

  const d1 = hashToField(lp1);
  const d2 = hashToField(lp2);
  assert(d1 !== d2, 'Digests differ for ambiguous inputs');
}

// Test 3: Determinism
console.log('\nTest 3: Determinism');
{
  const enc1 = lengthPrefixEncode('drop-alpha', '2', '100');
  const enc2 = lengthPrefixEncode('drop-alpha', '2', '100');
  assert(enc1 === enc2, 'Same inputs produce same encoding');

  const d1 = hashToField(enc1);
  const d2 = hashToField(enc2);
  assert(d1 === d2, 'Same inputs produce same digest');
}

// Test 4: Different contexts produce different digests (Scenario F/G basis)
console.log('\nTest 4: Cross-drop distinguishability');
{
  const dA = hashToField(lengthPrefixEncode('drop-alpha', '2', '100'));
  const dB = hashToField(lengthPrefixEncode('drop-beta', '2', '100'));
  assert(dA !== dB, 'Different dropIds → different digests');

  const dPv = hashToField(lengthPrefixEncode('drop-alpha', '3', '100'));
  assert(dA !== dPv, 'Different policyVersions → different digests');

  const dEp = hashToField(lengthPrefixEncode('drop-alpha', '2', '101'));
  assert(dA !== dEp, 'Different epochs → different digests');
}

// Test 5: Edge cases
console.log('\nTest 5: Edge cases');
{
  // Empty fields
  const empty = lengthPrefixEncode('', '', '');
  assert(empty === '000000000000', 'Empty fields encoded correctly');

  // Very long field
  const long = 'x'.repeat(9999);
  const longEnc = lengthPrefixEncode(long, '1', '1');
  assert(longEnc.startsWith('9999'), 'Long field length encoded correctly');

  // Fields with digits that look like length prefixes
  const tricky = lengthPrefixEncode('0003abc', '1', '1');
  const normal = lengthPrefixEncode('abc', '1', '1');
  assert(tricky !== normal, 'Numeric-looking fields do not collide');
}

console.log(`\n${'═'.repeat(63)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(63));

process.exit(failed > 0 ? 1 : 0);
