/**
 * make-irr-sample.mjs — build the inter-rater-reliability (IRR) coding kit.
 *
 * Draws a STRATIFIED sample of 200 public reviews from the same corpus and with
 * the same cleaning pipeline as ../code-reviews.mjs, joins back the VERBATIM
 * review text, and emits two blank coder worksheets plus a hidden machine key.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS STRATIFIES BY PREDICTED CODE (changed 2026-07)
 * ---------------------------------------------------------------------------
 * The original design stratified by app x rating-bucket. That yields a sample
 * that is representative of the corpus — and therefore useless for estimating
 * per-code reliability, because the corpus itself is sparse. Measured on the
 * app x bucket sample:
 *
 *     safety_need 32 | battery 11 | freshness 10 | control 8
 *     coordination 3 | precision 2 | monitoring 1
 *     accuracy 0 | trust_integrity 0        (70% of rows carried NO code)
 *
 * With 0-8 positives, Cohen's kappa is not estimable: chance agreement Pe
 * approaches 1, so near-perfect observed agreement still yields kappa near 0 or
 * undefined (the "kappa paradox"). compute-irr.mjs already returns null in that
 * degenerate case. Paying two coders for that sample would have bought a usable
 * kappa for exactly one of the nine codes.
 *
 * Stratifying by PREDICTED code fixes the composition at identical coding cost
 * (still 200 items). The trade-off is that the sample is no longer
 * corpus-representative, so corpus-level prevalence must come from the full
 * lexical run corrected by the precision/recall measured here — the standard
 * design for validating a classifier. The `other` stratum is retained
 * specifically so recall (the lexical coder's false negatives) stays estimable.
 *
 * ---------------------------------------------------------------------------
 * WHY safety_need IS SPLIT IN TWO
 * ---------------------------------------------------------------------------
 * safety_need is the dominant code and drives the headline number. Its lexical
 * rule fires on bare family nouns (son/daughter/mom/husband/...), but CODEBOOK.md
 * states the opposite: "Requires an explicit protective / wellbeing /
 * peace-of-mind / emergency framing. Merely naming a family member is not enough
 * on its own." Measured on the raw corpus, 126 of 224 safety_need hits (56%)
 * fire on a family noun with NO protective wording anywhere in the review.
 *
 * That subgroup is where the machine and the codebook disagree by construction,
 * so it is sampled as its own stratum. Its precision is the single number most
 * able to move the headline, and it deserves a direct estimate rather than a
 * handful of incidental rows.
 *
 * ---------------------------------------------------------------------------
 * Fully deterministic: a seeded PRNG (seed "irr-2026") drives both the
 * within-stratum sampling and the per-coder row shuffle. No Math.random / no
 * Date.now anywhere, so re-running reproduces byte-identical output.
 *
 * Outputs (all in this validation/ directory):
 *   irr-sample-coder-A.csv   blank worksheet, coder-A row order
 *   irr-sample-coder-B.csv   blank worksheet, coder-B row order (independent shuffle)
 *   irr-sample-key.json      sample_id -> {app, rating, bucket, stratum, machine_codes}
 *                            (the lexical coder's codes — kept OUT of the CSVs)
 *
 * Run:  node make-irr-sample.mjs
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { RULES_V1, RULES_V2, applyRules, SAFETY_PROTECTIVE } from '../lexical-rules.mjs';

const DIR = import.meta.dirname;      // .../eval/public-reviews/validation
const SRC = join(DIR, '..');          // .../eval/public-reviews

const SEED = 'irr-2026';
const SAMPLE_SIZE = 200;

// Column order for the human coder worksheets (task-specified order).
const CODES = [
  'safety_need',
  'battery_performance',
  'control_visibility',
  'freshness_complaint',
  'coordination_need',
  'monitoring_coercion',
  'accuracy_complaint',
  'precision_concern',
  'trust_integrity',
];

// Desired rows per stratum. Capped by availability; any shortfall is absorbed
// by the `other` stratum, which is by far the largest.
const TARGETS = {
  'safety_need@family': 35,     // the codebook/machine disagreement zone
  'safety_need@protective': 20,
  battery_performance: 18,
  control_visibility: 18,
  freshness_complaint: 18,
  coordination_need: 18,
  monitoring_coercion: 15,
  accuracy_complaint: 14,
  precision_concern: 7,
  trust_integrity: 6,
  other: 31,                    // recall arm: lexical false negatives
};

// ---------------------------------------------------------------------------
// Lexical rules — copied verbatim from ../code-reviews.mjs so the machine key
// matches the pipeline exactly. (code-reviews.mjs runs main() on import and
// exports nothing, so we replicate rather than import.)
//
// safety_need's patterns are additionally tagged protective/family so the
// stratum split above can be computed. The union is byte-identical to the
// original list; the tags change nothing about which reviews match.
// ---------------------------------------------------------------------------
function codeOne(text) {
  const codes = applyRules(text, RULES_V1);
  return codes.length ? codes : ['other'];
}

/** Which half of the safety_need rule fired? Only meaningful when safety_need did fire. */
function safetyFlavour(text) {
  const t = text.toLowerCase();
  const prot = SAFETY_PROTECTIVE.some(p => p.test(t));
  return prot ? 'protective' : 'family';
}

// ---------------------------------------------------------------------------
// Cleaning pipeline — identical semantics to ../code-reviews.mjs
// ---------------------------------------------------------------------------
function bucketRating(r) {
  if (r === null || r === undefined) return 'unknown';
  if (r <= 2) return 'low';
  if (r === 3) return 'mid';
  if (r >= 4) return 'high';
  return 'unknown';
}

function isEnglish(s) {
  if (!s) return false;
  const ascii = s.split('').filter(c => c.charCodeAt(0) < 128).length;
  return ascii / s.length > 0.85;
}

function deduplicate(list) {
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const key = (r.title + '|' + r.body).slice(0, 200).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32 seeded via FNV-1a string hash)
// ---------------------------------------------------------------------------
function xfnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rngFrom(seed) { return mulberry32(xfnv1a(seed)); }
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildCsv(rows) {
  const header = ['sample_id', 'app', 'rating', 'review_text', ...CODES, 'notes'];
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) {
    const cells = [r.sample_id, r.app, r.rating, r.review_text,
      ...CODES.map(() => ''),   // one blank 0/1 column per code
      ''];                      // blank notes column
    lines.push(cells.map(csvEscape).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

async function main() {
  const apple = JSON.parse(await readFile(join(SRC, 'apple-rss-reviews.json'), 'utf-8'));
  const play  = JSON.parse(await readFile(join(SRC, 'play-reviews.json'), 'utf-8'));

  const merged = {
    life360:  [...(apple.reviews.life360 || []), ...(play.reviews.life360 || [])],
    findmy:   [...(play.reviews.findmy   || [])],
    snapchat: [...(play.reviews.snapchat || [])],
    glympse:  [...(play.reviews.glympse  || [])],
    zenly:    [...(play.reviews.zenly    || [])],
  };

  // Clean, then code every eligible review with the lexical coder.
  const pool = [];
  for (const [slug, revs] of Object.entries(merged)) {
    const clean = deduplicate(revs
      .map(r => ({ ...r, title: r.title || '', body: r.body || '' }))
      .filter(r => (r.body && r.body.length >= 20) || (r.title && r.title.length >= 5))
      .filter(r => isEnglish((r.title || '') + ' ' + (r.body || ''))));
    for (const r of clean) {
      const text = ((r.title || '') + ' ' + (r.body || '')).trim();  // == lexical coder input
      const machine = codeOne(text).filter(c => c !== 'other');
      // V2 predictions ride along so the same human coding can score both
      // rulesets. Stratification stays on V1 (the ruleset the paper used);
      // V2 is restrictive-only, so every V2 positive is inside the V1
      // strata and is therefore covered by this sample.
      const machineV2 = applyRules(text, RULES_V2);
      pool.push({
        app: slug, rating: r.rating, bucket: bucketRating(r.rating), text,
        machine, machineV2,
      });
    }
  }

  // Corpus-wide predicted-positive counts, used to break multi-code ties by
  // rarity so scarce codes are not starved by common ones.
  const corpusCount = {};
  for (const c of CODES) corpusCount[c] = 0;
  for (const r of pool) for (const c of r.machine) corpusCount[c]++;

  // Assign each review to exactly ONE stratum (rarest code it carries).
  // Note: stratification only controls the sample's COMPOSITION. Every sampled
  // review is still coded on all nine codes by the humans, so a review filed
  // under, say, `trust_integrity` still contributes a safety_need judgement.
  const strata = {};
  for (const r of pool) {
    let stratum;
    if (r.machine.length === 0) {
      stratum = 'other';
    } else {
      const rarest = r.machine.slice().sort((a, b) =>
        (corpusCount[a] - corpusCount[b]) || a.localeCompare(b))[0];
      stratum = rarest === 'safety_need'
        ? 'safety_need@' + safetyFlavour(r.text)
        : rarest;
    }
    r.stratum = stratum;
    (strata[stratum] ||= []).push(r);
  }

  // Allocate: min(target, available); push any shortfall onto `other`.
  const keys = Object.keys(TARGETS).filter(k => (strata[k] || []).length > 0);
  const alloc = {};
  let assigned = 0;
  for (const k of keys) {
    if (k === 'other') continue;
    alloc[k] = Math.min(TARGETS[k], strata[k].length);
    assigned += alloc[k];
  }
  alloc.other = Math.min((strata.other || []).length, SAMPLE_SIZE - assigned);
  assigned += alloc.other;
  if (assigned < SAMPLE_SIZE) {
    console.warn('WARNING: corpus could only supply ' + assigned + ' of ' + SAMPLE_SIZE + ' rows.');
  }

  // Draw: per-stratum independent seeded shuffle -> take alloc[k].
  const picked = [];
  for (const key of Object.keys(alloc).sort()) {
    const rng = rngFrom(SEED + '::stratum::' + key);
    for (const r of shuffle(strata[key], rng).slice(0, alloc[key])) picked.push(r);
  }

  // CODEBOOK.md illustrates each code with verbatim excerpts from this same
  // corpus. Any sampled review that IS one of those excerpts arrives at the
  // coder pre-answered, which inflates agreement on that row. Flag them so the
  // analysis can report kappa with and without. (Not excluded from the draw:
  // for trust_integrity and precision_concern the corpus holds only 6 and 7
  // instances, so dropping any would cost more than the contamination does.)
  let codebookExcerpts = [];
  try {
    const cb = await readFile(join(DIR, 'CODEBOOK.md'), 'utf-8');
    codebookExcerpts = [...cb.matchAll(/`([^`]{40,})`/g)]
      .map(m => m[1].replace(/…/g, '').trim())
      .filter(Boolean);
  } catch { /* codebook absent — flag simply stays false */ }
  const isCodebookExample = text =>
    codebookExcerpts.some(e => text.includes(e.slice(0, 40)));

  // sample_id must NOT encode the stratum. Drawing stratum-by-stratum and then
  // numbering in that order made S001-S013 all accuracy_complaint, S140-S174 all
  // safety_need@family, and so on — 11 contiguous blocks. A coder who sorts by
  // id, or who simply notices that neighbouring ids feel thematically alike,
  // gets a free hint about what the row is "supposed" to be. Shuffle once more
  // with a dedicated seed before numbering. This renumbers rows; it does not
  // change which reviews were drawn.
  const ordered = shuffle(picked, rngFrom(SEED + '::sample-id-order'));

  // Inverse inclusion probability per row (Horvitz-Thompson weight). Sampling
  // fractions across strata span 2.7% (other) to 100% (trust_integrity), a 37x
  // spread, so any corpus-level quantity computed from this sample MUST be
  // weighted. compute-irr.mjs consumes this for precision/recall.
  const weightOf = stratum => strata[stratum].length / alloc[stratum];

  const sample = [];
  const keyJson = {};
  let i = 0;
  let contaminated = 0;
  for (const r of ordered) {
    const sample_id = 'S' + String(++i).padStart(3, '0');
    const cbEx = isCodebookExample(r.text);
    if (cbEx) contaminated++;
    sample.push({ sample_id, app: r.app, rating: r.rating, review_text: r.text });
    keyJson[sample_id] = {
      app: r.app, rating: r.rating, bucket: r.bucket,
      stratum: r.stratum,
      weight: weightOf(r.stratum),
      machine_codes: r.machine,
      machine_codes_v2: r.machineV2,
      machine_other: r.machine.length === 0,
      codebook_example: cbEx,
    };
  }

  // Independent per-coder row shuffles (different seeds) to reduce order effects.
  const rowsA = shuffle(sample, rngFrom(SEED + '::order-A'));
  const rowsB = shuffle(sample, rngFrom(SEED + '::order-B'));

  await writeFile(join(DIR, 'irr-sample-coder-A.csv'), buildCsv(rowsA), 'utf-8');
  await writeFile(join(DIR, 'irr-sample-coder-B.csv'), buildCsv(rowsB), 'utf-8');

  // Predicted positives per code IN THE DRAWN SAMPLE — the number that decides
  // whether kappa is estimable for each code.
  const inSample = {};
  for (const c of CODES) inSample[c] = 0;
  for (const r of picked) for (const c of r.machine) inSample[c]++;

  const keyOut = {
    meta: {
      seed: SEED,
      sample_size: sample.length,
      stratification: 'predicted lexical code (rarest-first), safety_need split protective/family',
      total_eligible: pool.length,
      codes: CODES,
      targets: TARGETS,
      predicted_positives_in_sample: inSample,
      codebook_example_rows: contaminated,
      codebook_example_note: 'Rows flagged codebook_example:true appear verbatim as illustrations in CODEBOOK.md, so coders see their intended coding before starting. Report kappa both including and excluding them.',
      note: 'machine_codes are the lexical coder output; NOT shown to human coders. Used only to score lexical precision/recall vs human consensus in compute-irr.mjs. Sample is stratified by predicted code and is therefore NOT corpus-representative: corpus prevalence must be estimated from the full lexical run corrected by the precision/recall measured here.',
    },
    strata: Object.fromEntries(Object.keys(alloc).sort()
      .map(k => [k, {
        eligible: strata[k].length,
        sampled: alloc[k],
        sampling_fraction: alloc[k] / strata[k].length,
        weight: strata[k].length / alloc[k],
      }])),
    key: keyJson,
  };
  await writeFile(join(DIR, 'irr-sample-key.json'), JSON.stringify(keyOut, null, 2), 'utf-8');

  // ---- Console report ------------------------------------------------------
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  IRR SAMPLE — stratified by predicted code  (seed="' + SEED + '", n=' + sample.length + ')');
  console.log('══════════════════════════════════════════════════════════');
  console.log('Total eligible (English, deduped): ' + pool.length);
  console.log('\nStratum                    eligible   sampled    frac   weight');
  for (const k of Object.keys(alloc).sort()) {
    const frac = alloc[k] / strata[k].length;
    console.log('  ' + k.padEnd(24) + String(strata[k].length).padStart(6) +
      String(alloc[k]).padStart(10) +
      (100 * frac).toFixed(1).padStart(8) + '%' +
      (strata[k].length / alloc[k]).toFixed(1).padStart(8));
  }
  console.log('  Sampling fractions span ' +
    (100 * Math.min(...Object.keys(alloc).map(k => alloc[k] / strata[k].length))).toFixed(1) + '% to ' +
    (100 * Math.max(...Object.keys(alloc).map(k => alloc[k] / strata[k].length))).toFixed(0) +
    '% -- corpus-level figures must use the weights.');
  console.log('\nPredicted positives per code IN THE SAMPLE (kappa feasibility):');
  console.log('   was  now   code');
  const BEFORE = {                     // app x bucket sample, for comparison
    safety_need: 32, battery_performance: 11, freshness_complaint: 10,
    control_visibility: 8, coordination_need: 3, precision_concern: 2,
    monitoring_coercion: 1, accuracy_complaint: 0, trust_integrity: 0,
  };
  for (const c of CODES) {
    const n = inSample[c];
    const flag = n >= 15 ? '' : n >= 8 ? '   (thin)' : '   (kappa unlikely to be estimable)';
    console.log('   ' + String(BEFORE[c]).padStart(3) + '  ' + String(n).padStart(3) +
      '   ' + c.padEnd(22) + flag);
  }
  console.log('\nRows that appear verbatim as CODEBOOK.md examples: ' + contaminated +
    ' of ' + sample.length + '  (flagged codebook_example in the key;');
  console.log('  coders see their intended coding in the codebook, so report kappa with and without)');
  console.log('\nWrote:');
  console.log('  irr-sample-coder-A.csv  (' + rowsA.length + ' rows)');
  console.log('  irr-sample-coder-B.csv  (' + rowsB.length + ' rows)');
  console.log('  irr-sample-key.json     (' + Object.keys(keyJson).length + ' machine-code entries)');
}

main().catch(e => { console.error(e); process.exit(1); });
