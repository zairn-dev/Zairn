/**
 * make-irr-sample.mjs — build the inter-rater-reliability (IRR) coding kit.
 *
 * Draws a STRATIFIED random sample of 200 public reviews (strata = app ×
 * rating-bucket) from the same corpus and with the same cleaning pipeline as
 * ../code-reviews.mjs, joins back the VERBATIM review text, and emits two
 * blank coder worksheets plus a hidden machine-code key.
 *
 * Fully deterministic: a seeded PRNG (seed "irr-2026") drives both the
 * within-stratum sampling and the per-coder row shuffle. No Math.random / no
 * Date.now anywhere, so re-running reproduces byte-identical output.
 *
 * Outputs (all in this validation/ directory):
 *   irr-sample-coder-A.csv   blank worksheet, coder-A row order
 *   irr-sample-coder-B.csv   blank worksheet, coder-B row order (independent shuffle)
 *   irr-sample-key.json      sample_id -> {app, rating, bucket, machine_codes}
 *                            (the lexical coder's codes — kept OUT of the CSVs)
 *
 * Run:  node make-irr-sample.mjs
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const DIR = import.meta.dirname;      // .../eval/public-reviews/validation
const SRC = join(DIR, '..');          // .../eval/public-reviews

const SEED = 'irr-2026';
const SAMPLE_SIZE = 200;
const MIN_PER_STRATUM = 2;

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

// ---------------------------------------------------------------------------
// Lexical rules — copied verbatim from ../code-reviews.mjs so the machine key
// matches the pipeline exactly. (code-reviews.mjs runs main() on import and
// exports nothing, so we replicate rather than import.)
// ---------------------------------------------------------------------------
const RULES = [
  { code: 'precision_concern', patterns: [
    /\b(approx|approximate|coars(e|er))/,
    /\b(less precise|not exact|rough location)/,
    /\b(neighbou?rhood|city[- ]level|region[- ]only)/,
    /\b(too precise|too accurate|too specific)/,
    /\b(exact location|exact address|pinpoint)/,
    /\b(down to the (inch|foot|meter|metre|house))/,
  ] },
  { code: 'monitoring_coercion', patterns: [
    /\b(controlling|control[- ]freak|possessive|jealous)/,
    /\b(stalk|stalker|stalking)/,
    /\b(spy|spying|surveillance|creep|creepy|invasive)/,
    /\b(forced to|made to|have to have|obligated|coerc)/,
    /\b(abusive|toxic (partner|relationship|parent))/,
    /\b(overbearing|helicopter (parent|mom|dad))/,
    /\b(big brother|watching me|watching my every)/,
    /\b(prison|grounded|feels like (jail|prison))/,
  ] },
  { code: 'freshness_complaint', patterns: [
    /\b(stale|outdated|not (updating|refreshing))/,
    /\b(won'?t update|doesn'?t update|never updates)/,
    /\b(delayed|delay in|lag(s|ging) behind)/,
    /\b(hours? (behind|old|stale|ago))/,
    /\b(last seen \d+)/,
    /\b(frozen (at|on)|stuck at|stuck on)/,
    /\b(real[- ]time|real time|live (location|update))/,
    /\b(keeps? loading|loading forever)/,
  ] },
  { code: 'accuracy_complaint', patterns: [
    /\b(inaccurate|inacurate|wrong location|incorrect)/,
    /\b(miles (off|away from|from where))/,
    /\b(says? (i|they|he|she) (am|are|is) (somewhere|at|in))/,
    /\b(false (arrival|departure|alert|notif|alarm))/,
    /\b(drift|drifting|keeps? moving|moves when)/,
    /\b(random (trip|location|place))/,
    /\b(says (i|they)'?m|thinks (i|they)'?m|placed me)/,
    /\b(way off|completely wrong|totally wrong)/,
  ] },
  { code: 'trust_integrity', patterns: [
    /\b(fake (location|gps|position)|spoof)/,
    /\b(lying|lied about|lies about)/,
    /\b(can'?t trust|don'?t trust|lost trust|trust issues)/,
    /\b(paus(e|ed|ing) (their )?location|ghost mode|bubble)/,
    /\b(tricks? the app|bypass|cheat the app|trick it)/,
    /\b(privacy (concern|issue|worry|violation|nightmare))/,
    /\b(data (broker|sold|sell|selling))/,
    /\b(sells? (our|your|my) (location|data))/,
    /\b(turned off without|quietly turned)/,
  ] },
  { code: 'battery_performance', patterns: [
    /\b(battery (drain|hog|killer|eater|life))/,
    /\b(drains? (my )?battery|eats? (the )?battery|battery dies)/,
    /\b(crash(es|ed|ing)?|freez(e|es|ing)|hangs?\b)/,
    /\b(slow|laggy|unresponsive|sluggish|choppy)/,
    /\b(overheats?|phone gets hot|makes my phone)/,
    /\b(buggy|bugs?\b|glitch(es|y)?|broken|doesn'?t work)/,
    /\b(won'?t load|won'?t open|keeps? crashing|force close)/,
    /\b(uninstall(ed|ing)?|reinstall(ed|ing)?)/,
  ] },
  { code: 'coordination_need', patterns: [
    /\b(pick[- ]?up|drop[- ]?off|pickup|dropoff)/,
    /\b(arrival|arrived|got there|reached|on (the|her|his) way)/,
    /\b(eta\b|estimated time|when .* arrive)/,
    /\b(meet(ing)? up|meet[- ]?up|meet(ing)? at)/,
    /\b(where (is|are|r) (you|they|he|she|my)|find (him|her|them|my friend))/,
    /\b(coordinat(e|ing|ion))/,
    /\b(share (my )?location|sharing location|sending location)/,
    /\b(glympse (to|with)|sent a glympse)/,
  ] },
  { code: 'safety_need', patterns: [
    /\b(safe(ty)?|peace of mind|comforting|reassur)/,
    /\b(emergenc(y|ies)|\bsos\b|911)/,
    /\b(crash (detect|alert)|accident detect)/,
    /\b(child(ren)?|kid(s)?|son|daughter|teen(ager)?)/,
    /\b(elderly|grandparent|mom|dad|mother|father|parent)/,
    /\b(husband|wife|spouse|partner|boyfriend|girlfriend)/,
    /\b(worry|worri(ed|es) about|scared|concerned)/,
    /\b(found (my|his|her) phone|lost my phone)/,
  ] },
  { code: 'control_visibility', patterns: [
    /\b(who can see|see who|who sees)/,
    /\b(turn (it )?off|toggle|disable|pause)/,
    /\b(per[- ]contact|individual (setting|control)|granular)/,
    /\b(selective(ly)? shar|share with only|share with just)/,
    /\b(hide (from|my location)|invisible to)/,
    /\b(opt[- ]?(in|out))/,
    /\b(setting(s)?|permission(s)?|privacy setting)/,
    /\b(notifications?|alerts? (for|when))/,
  ] },
];

function codeOne(text) {
  const t = text.toLowerCase();
  const codes = new Set();
  for (const rule of RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(t)) { codes.add(rule.code); break; }
    }
  }
  if (codes.size === 0) codes.add('other');
  return [...codes];
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

// ---------------------------------------------------------------------------
// Proportional allocation with a floor of MIN_PER_STRATUM per non-empty
// stratum. Deterministic largest-target greedy fill; always sums to n exactly
// (assuming totalN >= n, which holds here: 1631 eligible >> 200).
// ---------------------------------------------------------------------------
function allocate(strata, n) {
  const keys = Object.keys(strata).sort();
  const N = {}, alloc = {}, target = {};
  let totalN = 0;
  for (const k of keys) { N[k] = strata[k].length; totalN += N[k]; }
  if (totalN < n) throw new Error(`corpus too small: ${totalN} eligible < ${n} requested`);

  let assigned = 0;
  for (const k of keys) {
    alloc[k] = Math.min(MIN_PER_STRATUM, N[k]);
    target[k] = (n * N[k]) / totalN;
    assigned += alloc[k];
  }
  if (assigned > n) {
    throw new Error(`floor allocation ${assigned} exceeds sample size ${n} ` +
      `(too many strata for MIN_PER_STRATUM=${MIN_PER_STRATUM})`);
  }
  while (assigned < n) {
    let best = null, bestGap = -Infinity;
    for (const k of keys) {
      if (alloc[k] >= N[k]) continue;          // stratum exhausted
      const gap = target[k] - alloc[k];
      if (gap > bestGap) { bestGap = gap; best = k; }
    }
    if (best === null) break;                   // all strata exhausted (unreachable here)
    alloc[best]++; assigned++;
  }
  return { keys, N, alloc, totalN };
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

  // Clean each app + bucket into strata keyed "app|bucket" (pipeline order).
  const strata = {};
  for (const [slug, revs] of Object.entries(merged)) {
    const clean = deduplicate(revs
      .map(r => ({ ...r, title: r.title || '', body: r.body || '' }))
      .filter(r => (r.body && r.body.length >= 20) || (r.title && r.title.length >= 5))
      .filter(r => isEnglish((r.title || '') + ' ' + (r.body || ''))));
    for (const r of clean) {
      const text = ((r.title || '') + ' ' + (r.body || '')).trim();  // == lexical coder input
      const key = slug + '|' + bucketRating(r.rating);
      (strata[key] ||= []).push({ app: slug, rating: r.rating, bucket: bucketRating(r.rating), text });
    }
  }

  const { keys, N, alloc, totalN } = allocate(strata, SAMPLE_SIZE);

  // Draw the sample: per-stratum independent seeded shuffle -> take alloc[k].
  const picked = [];
  for (const key of keys) {
    const rng = rngFrom(SEED + '::stratum::' + key);
    const shuffled = shuffle(strata[key], rng);
    for (const r of shuffled.slice(0, alloc[key])) picked.push(r);
  }

  // Canonical order (stratum-key, then draw order) -> stable sample_id.
  const keyBucket = {};
  const sample = [];
  const keyJson = {};
  let i = 0;
  for (const r of picked) {
    const sample_id = 'S' + String(++i).padStart(3, '0');
    const machine = codeOne(r.text).filter(c => c !== 'other');
    sample.push({ sample_id, app: r.app, rating: r.rating, review_text: r.text });
    keyJson[sample_id] = {
      app: r.app, rating: r.rating, bucket: r.bucket,
      machine_codes: machine,
      machine_other: machine.length === 0,   // lexical coder assigned only 'other'
    };
    const bk = r.app + '|' + r.bucket;
    keyBucket[bk] = (keyBucket[bk] || 0) + 1;
  }

  // Independent per-coder row shuffles (different seeds) to reduce order effects.
  const rowsA = shuffle(sample, rngFrom(SEED + '::order-A'));
  const rowsB = shuffle(sample, rngFrom(SEED + '::order-B'));

  await writeFile(join(DIR, 'irr-sample-coder-A.csv'), buildCsv(rowsA), 'utf-8');
  await writeFile(join(DIR, 'irr-sample-coder-B.csv'), buildCsv(rowsB), 'utf-8');

  const keyOut = {
    meta: {
      seed: SEED,
      sample_size: SAMPLE_SIZE,
      min_per_stratum: MIN_PER_STRATUM,
      total_eligible: totalN,
      codes: CODES,
      note: 'machine_codes are the lexical coder output; NOT shown to human coders. Used only to score lexical precision/recall vs human consensus in compute-irr.mjs.',
    },
    strata: Object.fromEntries(keys.map(k => [k, { eligible: N[k], sampled: alloc[k] }])),
    key: keyJson,
  };
  await writeFile(join(DIR, 'irr-sample-key.json'), JSON.stringify(keyOut, null, 2), 'utf-8');

  // ---- Console report: stratification table -------------------------------
  const apps = ['life360', 'findmy', 'snapchat', 'glympse', 'zenly'];
  const buckets = ['low', 'mid', 'high'];
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  IRR STRATIFIED SAMPLE  (seed="' + SEED + '", n=' + sample.length + ')');
  console.log('══════════════════════════════════════════════════════════');
  console.log('Total eligible (English, deduped): ' + totalN);
  console.log('\nSampled rows per stratum (app × rating-bucket):');
  console.log('  app       ' + buckets.map(b => b.padStart(6)).join('') + '   total');
  let gtot = 0;
  for (const app of apps) {
    let rtot = 0;
    const cells = buckets.map(b => {
      const c = keyBucket[app + '|' + b] || 0; rtot += c; return String(c).padStart(6);
    });
    gtot += rtot;
    console.log('  ' + app.padEnd(10) + cells.join('') + '   ' + String(rtot).padStart(5));
  }
  const colTot = buckets.map(b => {
    let s = 0; for (const app of apps) s += keyBucket[app + '|' + b] || 0; return String(s).padStart(6);
  });
  console.log('  ' + 'TOTAL'.padEnd(10) + colTot.join('') + '   ' + String(gtot).padStart(5));

  console.log('\nEligible vs sampled per stratum:');
  for (const k of keys) console.log('  ' + k.padEnd(18) + 'eligible=' + String(N[k]).padStart(4) + '  sampled=' + String(alloc[k]).padStart(3));

  console.log('\nWrote:');
  console.log('  irr-sample-coder-A.csv  (' + rowsA.length + ' rows)');
  console.log('  irr-sample-coder-B.csv  (' + rowsB.length + ' rows)');
  console.log('  irr-sample-key.json     (' + Object.keys(keyJson).length + ' machine-code entries)');
}

main().catch(e => { console.error(e); process.exit(1); });
