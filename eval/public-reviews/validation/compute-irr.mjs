/**
 * compute-irr.mjs — inter-rater-reliability statistics for the IRR coding kit.
 *
 * Reads the two FILLED coder worksheets (irr-sample-coder-A.csv,
 * irr-sample-coder-B.csv) and reports, per code:
 *   - Cohen's kappa (binary)
 *   - Krippendorff's alpha (binary / nominal metric)
 *   - observed agreement (Po)
 * plus a pooled Cohen's kappa across all code×item cells, and the lexical
 * coder's precision / recall / F1 vs the human consensus (from
 * irr-sample-key.json machine_codes).
 *
 * Human consensus per (item, code):
 *   - both coders agree           -> that value is the gold label
 *   - coders disagree             -> use the adjudicated value from the
 *                                    optional resolution file if present,
 *                                    otherwise the cell is EXCLUDED from
 *                                    precision/recall (never guessed).
 * Optional resolution file: irr-sample-resolved.csv with columns
 *   sample_id + one 0/1 column per code (adjudicated gold for disagreements).
 *
 * Fully deterministic. No randomness, no clock reads.
 *
 * Run:  node compute-irr.mjs            # score the real filled worksheets
 *       node compute-irr.mjs --demo     # self-check the math on a known fixture
 */

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const DIR = import.meta.dirname;

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

// ---------------------------------------------------------------------------
// Minimal RFC-4180 CSV parser (handles quotes, escaped quotes, embedded
// commas / newlines). Returns array of row-objects keyed by header.
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (field !== '' || row.length) { row.push(field); rows.push(row); row = []; field = ''; }
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map(r => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ''])));
}

function toBinary(cell) {
  const s = String(cell ?? '').trim().toLowerCase();
  if (s === '1' || s === 'y' || s === 'yes' || s === 'true' || s === 'x') return 1;
  return 0;   // blank / 0 / anything else => not coded
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

// Cohen's kappa for two binary vectors. Returns { kappa, po, pe } where kappa
// may be null when undefined (pe === 1 and the raters are not identical).
function cohenKappa(a, b) {
  const n = a.length;
  if (n === 0) return { kappa: null, po: null, pe: null };
  let agree = 0, a1 = 0, b1 = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree++;
    if (a[i] === 1) a1++;
    if (b[i] === 1) b1++;
  }
  const po = agree / n;
  const pa1 = a1 / n, pb1 = b1 / n;
  const pe = pa1 * pb1 + (1 - pa1) * (1 - pb1);
  let kappa;
  if (pe === 1) kappa = (po === 1) ? 1 : null;   // no chance variance
  else kappa = (po - pe) / (1 - pe);
  return { kappa, po, pe };
}

// Krippendorff's alpha for two coders, complete binary data, nominal metric.
// Coincidence matrix built with the m_u = 2 rule: an agreeing unit adds 2 to
// the diagonal; a disagreeing unit adds 1 to each off-diagonal cell.
function krippendorffAlphaBinary(a, b) {
  const n = a.length;
  if (n === 0) return null;
  const o = [[0, 0], [0, 0]];
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (x === y) o[x][x] += 2;
    else { o[x][y] += 1; o[y][x] += 1; }
  }
  const total = 2 * n;
  const nv = [o[0][0] + o[0][1], o[1][0] + o[1][1]];
  const Do = (o[0][1] + o[1][0]) / total;                       // observed disagreement
  const De = (2 * nv[0] * nv[1]) / (total * (total - 1));       // expected disagreement
  if (De === 0) return Do === 0 ? 1 : null;
  return 1 - Do / De;
}

function fmt(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return '   n/a';
  return (x >= 0 ? ' ' : '') + x.toFixed(4);
}

// ---------------------------------------------------------------------------
// --demo : validate the math against a fixture with a hand-computed answer.
// 50 units, 2 coders, binary:  both-yes=20, both-no=15, A1B0=5, A0B1=10.
//   Cohen's kappa      = 0.4   (Po=0.70, Pe=0.50)
//   Krippendorff alpha = 0.4   (Do=0.30, De=0.50)
// Plus a perfect-agreement fixture (kappa = alpha = 1).
// ---------------------------------------------------------------------------
function runDemo() {
  const a = [], b = [];
  const push = (n, av, bv) => { for (let i = 0; i < n; i++) { a.push(av); b.push(bv); } };
  push(20, 1, 1); push(15, 0, 0); push(5, 1, 0); push(10, 0, 1);

  const { kappa, po, pe } = cohenKappa(a, b);
  const alpha = krippendorffAlphaBinary(a, b);

  const EXP_K = 0.4, EXP_A = 0.4, TOL = 1e-9;
  const okK = Math.abs(kappa - EXP_K) < TOL;
  const okA = Math.abs(alpha - EXP_A) < TOL;

  // perfect-agreement edge case
  const pa = [1, 0, 1, 1, 0], pb = [1, 0, 1, 1, 0];
  const pk = cohenKappa(pa, pb).kappa;
  const palpha = krippendorffAlphaBinary(pa, pb);
  const okPerfect = pk === 1 && palpha === 1;

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  DEMO — kappa/alpha self-check');
  console.log('══════════════════════════════════════════════════════════');
  console.log('Fixture: n=50  both-yes=20 both-no=15 A1B0=5 A0B1=10');
  console.log(`  Po                 = ${po.toFixed(4)}   (expected 0.7000)`);
  console.log(`  Pe                 = ${pe.toFixed(4)}   (expected 0.5000)`);
  console.log(`  Cohen's kappa      = ${kappa.toFixed(4)}   (expected ${EXP_K.toFixed(4)})  ${okK ? 'PASS' : 'FAIL'}`);
  console.log(`  Krippendorff alpha = ${alpha.toFixed(4)}   (expected ${EXP_A.toFixed(4)})  ${okA ? 'PASS' : 'FAIL'}`);
  console.log(`Edge: perfect agreement -> kappa=${pk}, alpha=${palpha}  ${okPerfect ? 'PASS' : 'FAIL'}`);

  const allPass = okK && okA && okPerfect;
  console.log('\n  RESULT: ' + (allPass ? 'ALL PASS' : 'FAILURE'));
  process.exit(allPass ? 0 : 1);
}

// ---------------------------------------------------------------------------
// main : score the real filled worksheets
// ---------------------------------------------------------------------------
async function main() {
  const fA = join(DIR, 'irr-sample-coder-A.csv');
  const fB = join(DIR, 'irr-sample-coder-B.csv');
  const fKey = join(DIR, 'irr-sample-key.json');
  for (const f of [fA, fB, fKey]) {
    if (!existsSync(f)) {
      console.error('Missing ' + f + ' — run make-irr-sample.mjs first (and have both coders fill their CSVs).');
      process.exit(1);
    }
  }

  const rowsA = parseCsv(await readFile(fA, 'utf-8'));
  const rowsB = parseCsv(await readFile(fB, 'utf-8'));
  const key = JSON.parse(await readFile(fKey, 'utf-8'));

  const mapA = new Map(rowsA.map(r => [r.sample_id, r]));
  const mapB = new Map(rowsB.map(r => [r.sample_id, r]));
  const ids = [...mapA.keys()].filter(id => mapB.has(id)).sort();

  // Optional adjudicated resolution for disagreements.
  const fRes = join(DIR, 'irr-sample-resolved.csv');
  let resolved = null;
  if (existsSync(fRes)) {
    resolved = new Map(parseCsv(await readFile(fRes, 'utf-8')).map(r => [r.sample_id, r]));
    console.log('Using adjudicated resolutions from irr-sample-resolved.csv');
  }

  // Detect unfilled worksheets.
  let totalPos = 0;
  for (const id of ids) for (const c of CODES) totalPos += toBinary(mapA.get(id)[c]) + toBinary(mapB.get(id)[c]);
  if (totalPos === 0) {
    console.log('\n⚠  Both coder CSVs contain no 1/0 labels yet — they appear UNFILLED.');
    console.log('   Fill the per-code columns with 1 (code applies) / 0 (does not) and re-run.');
    console.log('   (Kappa/alpha are undefined without variance; showing structure only.)\n');
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  INTER-RATER RELIABILITY   (n=' + ids.length + ' items, 2 coders)');
  console.log('══════════════════════════════════════════════════════════');
  console.log('code                      Po     kappa    alpha    A+   B+');
  console.log('------------------------------------------------------------');

  const pooledA = [], pooledB = [];
  const perCode = {};
  for (const c of CODES) {
    const a = ids.map(id => toBinary(mapA.get(id)[c]));
    const b = ids.map(id => toBinary(mapB.get(id)[c]));
    pooledA.push(...a); pooledB.push(...b);
    const { kappa, po } = cohenKappa(a, b);
    const alpha = krippendorffAlphaBinary(a, b);
    perCode[c] = { kappa, alpha, po };
    const aPos = a.reduce((s, v) => s + v, 0), bPos = b.reduce((s, v) => s + v, 0);
    console.log(
      c.padEnd(22) + fmt(po) + '  ' + fmt(kappa) + '  ' + fmt(alpha) +
      '  ' + String(aPos).padStart(3) + '  ' + String(bPos).padStart(3));
  }

  const pooled = cohenKappa(pooledA, pooledB);
  const pooledAlpha = krippendorffAlphaBinary(pooledA, pooledB);
  console.log('------------------------------------------------------------');
  console.log('POOLED (all codes)'.padEnd(22) + fmt(pooled.po) + '  ' + fmt(pooled.kappa) + '  ' + fmt(pooledAlpha));

  const valid = Object.values(perCode).map(v => v.kappa).filter(k => k !== null && !Number.isNaN(k));
  if (valid.length) {
    const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
    console.log('mean per-code kappa (defined codes only): ' + mean.toFixed(4) + '  (' + valid.length + '/' + CODES.length + ' codes)');
  }

  // ---- Lexical coder precision / recall vs human consensus -----------------
  //
  // The sample is stratified by PREDICTED code, so it deliberately
  // over-represents rows the lexical coder called positive. Two consequences:
  //
  //   * Sample-level (unweighted) figures describe the enriched sample only.
  //     Recall in particular is badly optimistic there, because false
  //     negatives live almost entirely in the `other` stratum, which is
  //     sampled at a few percent while some positive strata are sampled at
  //     100%.
  //   * Corpus-level figures need Horvitz-Thompson weighting by the inverse
  //     inclusion probability, which make-irr-sample.mjs writes to
  //     key.key[id].weight.
  //
  // Both are printed. The weighted block is the one that describes the corpus.
  const hasWeights = ids.every(id => typeof key.key[id]?.weight === 'number');
  if (!hasWeights) {
    console.log('\n⚠  key.json has no per-row `weight` field — regenerate it with');
    console.log('   make-irr-sample.mjs to get corpus-level (weighted) estimates.');
  }

  /** Tally TP/FP/FN (raw and weighted) for one ruleset field in the key. */
  function tally(field) {
    const acc = {};
    for (const c of CODES) acc[c] = { TP: 0, FP: 0, FN: 0, excl: 0, wTP: 0, wFP: 0, wFN: 0 };
    for (const c of CODES) {
      for (const id of ids) {
        const av = toBinary(mapA.get(id)[c]);
        const bv = toBinary(mapB.get(id)[c]);
        let gold;
        if (av === bv) gold = av;
        else if (resolved && resolved.has(id)) gold = toBinary(resolved.get(id)[c]);
        else { acc[c].excl++; continue; }     // unresolved disagreement -> excluded
        const machine = (key.key[id]?.[field] || []).includes(c) ? 1 : 0;
        const w = hasWeights ? key.key[id].weight : 1;
        if (machine === 1 && gold === 1) { acc[c].TP++; acc[c].wTP += w; }
        else if (machine === 1 && gold === 0) { acc[c].FP++; acc[c].wFP += w; }
        else if (machine === 0 && gold === 1) { acc[c].FN++; acc[c].wFN += w; }
      }
    }
    return acc;
  }

  // V1 is the ruleset that produced the published numbers. V2 is the
  // codebook-corrected ruleset (see ../lexical-rules.mjs). Both are scored
  // against the same human gold so the correction's cost is measurable.
  const hasV2 = ids.some(id => Array.isArray(key.key[id]?.machine_codes_v2));
  const RULESETS = [{ label: 'V1 (as published)', field: 'machine_codes' }];
  if (hasV2) RULESETS.push({ label: 'V2 (codebook-corrected)', field: 'machine_codes_v2' });

  const acc = tally('machine_codes');

  const prf = (tp, fp, fn) => {
    const p = (tp + fp) ? tp / (tp + fp) : null;
    const r = (tp + fn) ? tp / (tp + fn) : null;
    const f = (p && r && (p + r)) ? 2 * p * r / (p + r) : null;
    return { p, r, f };
  };

  let mExcl = 0;
  for (const { label, field } of RULESETS) {
    const A = field === 'machine_codes' ? acc : tally(field);

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  LEXICAL CODER ' + label + ' vs HUMAN CONSENSUS');
    console.log('  sample level (unweighted) — describes the enriched sample,');
    console.log('  NOT the corpus. Recall here is optimistic by construction.');
    console.log('══════════════════════════════════════════════════════════');
    console.log('code                    prec   recall     F1    (TP  FP  FN)   excl');
    console.log('---------------------------------------------------------------------');
    let mTP = 0, mFP = 0, mFN = 0, ex = 0;
    for (const c of CODES) {
      const { TP, FP, FN, excl } = A[c];
      mTP += TP; mFP += FP; mFN += FN; ex += excl;
      const { p, r, f } = prf(TP, FP, FN);
      console.log(
        c.padEnd(22) + fmt(p) + '  ' + fmt(r) + '  ' + fmt(f) +
        '   (' + String(TP).padStart(2) + '  ' + String(FP).padStart(2) + '  ' + String(FN).padStart(2) + ')   ' + String(excl).padStart(3));
    }
    mExcl = ex;
    {
      const { p, r, f } = prf(mTP, mFP, mFN);
      console.log('---------------------------------------------------------------------');
      console.log('MICRO (all codes)'.padEnd(22) + fmt(p) + '  ' + fmt(r) + '  ' + fmt(f) +
        '   (' + String(mTP).padStart(2) + '  ' + String(mFP).padStart(2) + '  ' + String(mFN).padStart(2) + ')   ' + String(ex).padStart(3));
    }

    if (hasWeights) {
      const fracs = Object.values(key.strata || {})
        .map(s => s.sampling_fraction).filter(x => typeof x === 'number');
      console.log('\n  --- ' + label + ': CORPUS-LEVEL, inverse-probability weighted ---');
      if (fracs.length) {
        console.log('  Stratum sampling fractions span ' + (100 * Math.min(...fracs)).toFixed(1) +
          '% to ' + (100 * Math.max(...fracs)).toFixed(0) + '%. These describe the full corpus.');
      }
      console.log('code                    prec   recall     F1      (TPw    FPw    FNw)');
      console.log('---------------------------------------------------------------------');
      let wTP = 0, wFP = 0, wFN = 0;
      for (const c of CODES) {
        const a = A[c];
        wTP += a.wTP; wFP += a.wFP; wFN += a.wFN;
        const { p, r, f } = prf(a.wTP, a.wFP, a.wFN);
        console.log(
          c.padEnd(22) + fmt(p) + '  ' + fmt(r) + '  ' + fmt(f) +
          '   (' + a.wTP.toFixed(0).padStart(5) + '  ' + a.wFP.toFixed(0).padStart(5) +
          '  ' + a.wFN.toFixed(0).padStart(5) + ')');
      }
      const { p, r, f } = prf(wTP, wFP, wFN);
      console.log('---------------------------------------------------------------------');
      console.log('MICRO (all codes)'.padEnd(22) + fmt(p) + '  ' + fmt(r) + '  ' + fmt(f) +
        '   (' + wTP.toFixed(0).padStart(5) + '  ' + wFP.toFixed(0).padStart(5) + '  ' + wFN.toFixed(0).padStart(5) + ')');
      console.log('  TPw/FPw/FNw are estimated corpus counts, not row counts.');
    }
  }
  if (!hasV2) {
    console.log('\nNote: key.json has no machine_codes_v2 — regenerate with');
    console.log('      make-irr-sample.mjs to score the codebook-corrected ruleset too.');
  }

  // ---- Codebook-example contamination -------------------------------------
  const cbIds = ids.filter(id => key.key[id]?.codebook_example);
  console.log('\nRows that also appear as CODEBOOK.md examples: ' + cbIds.length +
    (cbIds.length === 0 ? '  (no contamination)' : ''));
  if (cbIds.length) {
    const keep = ids.filter(id => !key.key[id]?.codebook_example);
    const pa = [], pb = [];
    for (const c of CODES) for (const id of keep) {
      pa.push(toBinary(mapA.get(id)[c])); pb.push(toBinary(mapB.get(id)[c]));
    }
    const k2 = cohenKappa(pa, pb);
    console.log('  Those rows arrive pre-answered (both coders read the codebook),');
    console.log('  so they inflate agreement. Pooled kappa excluding them (n=' +
      keep.length + '): ' + fmt(k2.kappa) + '   [including: ' + fmt(pooled.kappa) + ']');
    console.log('  Report both.');
  }

  if (!resolved && mExcl > 0) {
    console.log('\nNote: ' + mExcl + ' code-cells excluded (coder disagreement, no adjudication).');
    console.log('      Provide irr-sample-resolved.csv to fold them back in.');
  }
}

if (process.argv.includes('--demo')) runDemo();
else main().catch(e => { console.error(e); process.exit(1); });
