// Summarise the filled UI-audit sheet (docs/ui-audit/audit-sheet.csv).
//
// Computes the paper's headline: the share of presence cues that are
// displayed as asserted-as-fact (vs hedged-uncertain / raw-data), overall
// and broken down by construct (K1..K5) and by app. Operates ONLY on
// human-coded rows — it never invents codes; rows with an empty
// display_form are reported as uncoded and excluded from percentages.
//
//   node docs/ui-audit/summarize-audit.mjs
//
// Mirrors the role of eval/public-reviews/validation/compute-irr.mjs for
// the UI-audit half of the honesty-gap argument.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const SHEET = join(DIR, 'audit-sheet.csv');

const FORMS = ['asserted-as-fact', 'hedged-uncertain', 'raw-data'];
const CONSTRUCTS = ['K1', 'K2', 'K3', 'K4', 'K5'];

/** Minimal RFC-4180-ish CSV parser (handles quoted fields with commas/quotes). */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.trim());
  return rows
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

function pct(n, d) {
  return d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(1).padStart(5)}%`;
}

function bar(n, d, width = 24) {
  const filled = d === 0 ? 0 : Math.round((width * n) / d);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

const rows = parseCsv(await readFile(SHEET, 'utf-8'));
const coded = rows.filter((r) => FORMS.includes(r.display_form));
const uncoded = rows.filter((r) => !FORMS.includes(r.display_form));

console.log('\n══════════════════════════════════════════════════════════');
console.log('  UI-audit summary — presence cues by display form');
console.log('══════════════════════════════════════════════════════════');
console.log(`  rows total: ${rows.length}   coded: ${coded.length}   uncoded: ${uncoded.length}`);

if (uncoded.length) {
  const bad = uncoded.filter((r) => r.display_form);
  if (bad.length) {
    console.log(`\n  ⚠ ${bad.length} row(s) have an unrecognised display_form (expected one of ${FORMS.join(' / ')}):`);
    for (const r of bad.slice(0, 8)) console.log(`      ${r.screenshot_filename || r.app}: "${r.display_form}"`);
  }
  console.log(`\n  ${uncoded.length} row(s) not yet coded — excluded from percentages.`);
}

if (coded.length === 0) {
  console.log('\n  Nothing coded yet. Fill display_form (and construct) per PROTOCOL.md, then re-run.\n');
  process.exit(0);
}

// Overall by display form.
console.log('\n  Overall (coded cues):');
for (const f of FORMS) {
  const n = coded.filter((r) => r.display_form === f).length;
  console.log(`    ${f.padEnd(18)} ${bar(n, coded.length)} ${String(n).padStart(3)}  ${pct(n, coded.length)}`);
}

const assertedN = coded.filter((r) => r.display_form === 'asserted-as-fact').length;
console.log(`\n  HEADLINE: ${pct(assertedN, coded.length)} of presence cues are asserted-as-fact ` +
  `(${assertedN}/${coded.length}).`);

// By construct.
console.log('\n  Asserted-as-fact rate by construct:');
for (const k of CONSTRUCTS) {
  const inK = coded.filter((r) => (r.construct || '').toUpperCase() === k);
  const a = inK.filter((r) => r.display_form === 'asserted-as-fact').length;
  console.log(`    ${k}  ${bar(a, inK.length)} ${String(a).padStart(3)}/${String(inK.length).padEnd(3)}  ${pct(a, inK.length)}`);
}
const noK = coded.filter((r) => !CONSTRUCTS.includes((r.construct || '').toUpperCase()));
if (noK.length) console.log(`    (${noK.length} coded row(s) have no/unknown construct)`);

// By app.
console.log('\n  Asserted-as-fact rate by app:');
const apps = [...new Set(coded.map((r) => r.app))];
for (const app of apps) {
  const inApp = coded.filter((r) => r.app === app);
  const a = inApp.filter((r) => r.display_form === 'asserted-as-fact').length;
  console.log(`    ${(app || '(blank)').padEnd(16)} ${bar(a, inApp.length)} ${String(a).padStart(3)}/${String(inApp.length).padEnd(3)}  ${pct(a, inApp.length)}`);
}
console.log('');
