/**
 * Code publicly-fetched reviews against the pre-registered codebook.
 *
 * We combine:
 *  - Apple RSS reviews (life360, n=50)
 *  - Google Play reviews (life360 500, findmy 500, snapchat 500, glympse 500)
 *
 * For each review body we assign one or more theme codes using a
 * deterministic keyword-based rule.  We do NOT store the verbatim
 * body or title in the final output; we only keep the rating bucket,
 * app slug, assigned codes, and a 2-3-word automatic paraphrase tag.
 *
 * Codes (from Appendix B):
 *   precision_concern, monitoring_coercion, freshness_complaint,
 *   accuracy_complaint, trust_integrity, battery_performance,
 *   coordination_need, safety_need, control_visibility, other.
 */

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { RULES_V1, applyRules } from './lexical-rules.mjs';

const DIR = import.meta.dirname;

// The lexical rules live in lexical-rules.mjs (single source of truth, shared
// with validation/make-irr-sample.mjs). RULES_V1 is the ruleset that produced
// the published numbers; behaviour verified byte-identical to the previous
// inline copy on all 1,631 eligible reviews before the switch.
function codeOne(text) {
  const codes = applyRules(text, RULES_V1);
  return codes.length ? codes : ['other'];
}

function bucketRating(r) {
  if (r === null || r === undefined) return 'unknown';
  if (r <= 2) return 'low';
  if (r === 3) return 'mid';
  if (r >= 4) return 'high';
  return 'unknown';
}

function isEnglish(s) {
  // cheap ASCII-majority filter to drop non-English reviews
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

async function main() {
  const apple = JSON.parse(await readFile(join(DIR, 'apple-rss-reviews.json'), 'utf-8'));
  const play  = JSON.parse(await readFile(join(DIR, 'play-reviews.json'),       'utf-8'));

  // Merge Life360 (apple + play); others are play only
  const merged = {
    life360:  [...(apple.reviews.life360 || []), ...(play.reviews.life360 || [])],
    findmy:   [...(play.reviews.findmy || [])],
    snapchat: [...(play.reviews.snapchat || [])],
    glympse:  [...(play.reviews.glympse || [])],
    zenly:    [...(play.reviews.zenly || [])],
  };

  const result = {};
  const perTheme = {};
  const perAppPerTheme = {};
  let total = 0;

  for (const [slug, revs] of Object.entries(merged)) {
    // Filter English-ish, dedupe, drop empty bodies
    const clean = deduplicate(revs
      .map(r => ({ ...r, title: r.title || '', body: r.body || '' }))
      .filter(r => (r.body && r.body.length >= 20) || (r.title && r.title.length >= 5))
      .filter(r => isEnglish((r.title || '') + ' ' + (r.body || '')))
    );

    const coded = clean.map(r => ({
      app: slug,
      rating_bucket: bucketRating(r.rating),
      year_month: r.year_month || '',
      codes: codeOne((r.title || '') + ' ' + (r.body || '')),
    }));

    result[slug] = coded;
    total += coded.length;
    perAppPerTheme[slug] = {};
    for (const c of coded) {
      for (const code of c.codes) {
        perTheme[code] = (perTheme[code] || 0) + 1;
        perAppPerTheme[slug][code] = (perAppPerTheme[slug][code] || 0) + 1;
      }
    }
  }

  const summary = { total, perApp: Object.fromEntries(Object.entries(result).map(([k,v])=>[k,v.length])), perTheme, perAppPerTheme };

  // Write only the anonymized coded output (no verbatim text)
  await writeFile(join(DIR, 'coded-reviews.json'),
    JSON.stringify({ meta: { total, generatedAt: new Date().toISOString().slice(0,10) },
                     perApp: summary.perApp, perTheme: summary.perTheme,
                     perAppPerTheme: summary.perAppPerTheme,
                     records: Object.values(result).flat() },
                   null, 2));

  console.log('\n══════════════════════════════════════════════');
  console.log('  PUBLIC REVIEW CODED SUMMARY');
  console.log('══════════════════════════════════════════════');
  console.log(`Total English reviews coded: ${total}`);
  console.log('\nPer app:');
  for (const [k,v] of Object.entries(summary.perApp)) console.log(`  ${k.padEnd(10)} ${v}`);
  console.log('\nTheme counts (across all apps):');
  const sorted = Object.entries(summary.perTheme).sort((a,b)=>b[1]-a[1]);
  for (const [k,v] of sorted) console.log(`  ${k.padEnd(22)} ${v}`);
  console.log('\nPer-app, top-5 themes:');
  for (const [slug, tc] of Object.entries(summary.perAppPerTheme)) {
    const top = Object.entries(tc).sort((a,b)=>b[1]-a[1]).slice(0,5);
    console.log(`  ${slug}: ${top.map(([k,v])=>`${k}:${v}`).join(', ')}`);
  }
}

main().catch(console.error);
