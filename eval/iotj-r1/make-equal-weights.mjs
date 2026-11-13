// Equal-weight robustness check (R1-8, R2-4, R3-3).
//
// Copies the evaluation scripts to eval/iotj-r1-equal/ and replaces every
// weight profile with equal weights: V1 1/3 each, V2/V2r all five 0.2 each,
// four-signal profiles 0.25 each. Everything else (signals, rounding,
// thresholds, data) is unchanged. paper-scorer.mjs stays frozen here; only the
// copy is edited. The results already in results/ are copied as well, so the
// weight-free ones (step-up trials, proof size, C port) are available to
// make-numbers.mjs.
//
// Usage:
//   node eval/iotj-r1/make-equal-weights.mjs
//   cd eval/iotj-r1-equal && for s in baseline stepup s4 dense-trace shl field tradeoff latch; do node run-$s.mjs; done
//   node eval/iotj-r1/make-numbers.mjs   # reads iotj-r1-equal/results for the \nEq* macros

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, '..', 'iotj-r1-equal');
mkdirSync(join(dest, 'results'), { recursive: true });
for (const f of readdirSync(here)) if (f.endsWith('.mjs') && f !== 'make-equal-weights.mjs') cpSync(join(here, f), join(dest, f));
// Results that do not depend on the weights are refreshed; the others are
// copied only if missing, so a rerun never overwrites equal-weight results.
const WEIGHT_FREE = ['stepup-trials.json', 'proof-size.json', 'c-scorer.json'];
for (const f of readdirSync(join(here, 'results'))) {
  if (!f.endsWith('.json')) continue;
  if (WEIGHT_FREE.includes(f) || !existsSync(join(dest, 'results', f))) cpSync(join(here, 'results', f), join(dest, 'results', f));
}

const THIRD = '(1 / 3)';
const EDITS = {
  'paper-scorer.mjs': [
    ['const WEIGHT_MOVEMENT = 0.5;\nconst WEIGHT_ACCURACY = 0.2;\nconst WEIGHT_TEMPORAL = 0.3;',
      `const WEIGHT_MOVEMENT = ${THIRD};\nconst WEIGHT_ACCURACY = ${THIRD};\nconst WEIGHT_TEMPORAL = ${THIRD};`],
    ['wM = 0.30;\n        wA = 0.10;\n        wT = 0.15;\n        wF = 0.25;\n        wN = 0.20;',
      'wM = 0.20;\n        wA = 0.20;\n        wT = 0.20;\n        wF = 0.20;\n        wN = 0.20;'],
    ['wM = 0.35;\n        wA = 0.15;\n        wT = 0.20;\n        wF = 0.30;\n        wN = 0;',
      'wM = 0.25;\n        wA = 0.25;\n        wT = 0.25;\n        wF = 0.25;\n        wN = 0;'],
    ['wM = 0.40;\n        wA = 0.15;\n        wT = 0.20;\n        wF = 0;\n        wN = 0.25;',
      'wM = 0.25;\n        wA = 0.25;\n        wT = 0.25;\n        wF = 0;\n        wN = 0.25;'],
  ],
  'revised-scorer.mjs': [
    ['both: { movementPlausibility: 0.30, accuracyAnomaly: 0.10, temporalConsistency: 0.15, fixConsistency: 0.25, networkConsistency: 0.20 },',
      'both: { movementPlausibility: 0.2, accuracyAnomaly: 0.2, temporalConsistency: 0.2, fixConsistency: 0.2, networkConsistency: 0.2 },'],
    ['fixesOnly: { movementPlausibility: 0.35, accuracyAnomaly: 0.15, temporalConsistency: 0.20, fixConsistency: 0.30 },',
      'fixesOnly: { movementPlausibility: 0.25, accuracyAnomaly: 0.25, temporalConsistency: 0.25, fixConsistency: 0.25 },'],
    ['networkOnly: { movementPlausibility: 0.40, accuracyAnomaly: 0.15, temporalConsistency: 0.20, networkConsistency: 0.25 },',
      'networkOnly: { movementPlausibility: 0.25, accuracyAnomaly: 0.25, temporalConsistency: 0.25, networkConsistency: 0.25 },'],
    ['none: { movementPlausibility: 0.50, accuracyAnomaly: 0.20, temporalConsistency: 0.30 },',
      `none: { movementPlausibility: ${THIRD}, accuracyAnomaly: ${THIRD}, temporalConsistency: ${THIRD} },`],
  ],
  'fusion.mjs': [
    ['all5: [0.30, 0.10, 0.15, 0.25, 0.20],', 'all5: [0.2, 0.2, 0.2, 0.2, 0.2],'],
    ['noNetwork: [0.35, 0.15, 0.20, 0.30, 0],', 'noNetwork: [0.25, 0.25, 0.25, 0.25, 0],'],
  ],
};

for (const [file, edits] of Object.entries(EDITS)) {
  let s = readFileSync(join(dest, file), 'utf8');
  for (const [from, to] of edits) {
    const n = s.split(from).length - 1;
    if (n !== 1) throw new Error(`${file}: expected one match, found ${n}: ${from.slice(0, 50)}`);
    s = s.replace(from, to);
  }
  writeFileSync(join(dest, file), s);
}
console.error(`equal-weight copy written to ${dest}`);
