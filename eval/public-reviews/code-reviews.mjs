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

const DIR = import.meta.dirname;

// Deterministic lexical rules.  Each rule is a test of the lowercased
// body + title; multiple rules can fire per review.
const RULES = [
  {
    code: 'precision_concern',
    patterns: [
      /\b(approx|approximate|coars(e|er))/,
      /\b(less precise|not exact|rough location)/,
      /\b(neighbou?rhood|city[- ]level|region[- ]only)/,
      /\b(too precise|too accurate|too specific)/,
      /\b(exact location|exact address|pinpoint)/,
      /\b(down to the (inch|foot|meter|metre|house))/,
    ],
  },
  {
    code: 'monitoring_coercion',
    patterns: [
      /\b(controlling|control[- ]freak|possessive|jealous)/,
      /\b(stalk|stalker|stalking)/,
      /\b(spy|spying|surveillance|creep|creepy|invasive)/,
      /\b(forced to|made to|have to have|obligated|coerc)/,
      /\b(abusive|toxic (partner|relationship|parent))/,
      /\b(overbearing|helicopter (parent|mom|dad))/,
      /\b(big brother|watching me|watching my every)/,
      /\b(prison|grounded|feels like (jail|prison))/,
    ],
  },
  {
    code: 'freshness_complaint',
    patterns: [
      /\b(stale|outdated|not (updating|refreshing))/,
      /\b(won'?t update|doesn'?t update|never updates)/,
      /\b(delayed|delay in|lag(s|ging) behind)/,
      /\b(hours? (behind|old|stale|ago))/,
      /\b(last seen \d+)/,
      /\b(frozen (at|on)|stuck at|stuck on)/,
      /\b(real[- ]time|real time|live (location|update))/,
      /\b(keeps? loading|loading forever)/,
    ],
  },
  {
    code: 'accuracy_complaint',
    patterns: [
      /\b(inaccurate|inacurate|wrong location|incorrect)/,
      /\b(miles (off|away from|from where))/,
      /\b(says? (i|they|he|she) (am|are|is) (somewhere|at|in))/,
      /\b(false (arrival|departure|alert|notif|alarm))/,
      /\b(drift|drifting|keeps? moving|moves when)/,
      /\b(random (trip|location|place))/,
      /\b(says (i|they)'?m|thinks (i|they)'?m|placed me)/,
      /\b(way off|completely wrong|totally wrong)/,
    ],
  },
  {
    code: 'trust_integrity',
    patterns: [
      /\b(fake (location|gps|position)|spoof)/,
      /\b(lying|lied about|lies about)/,
      /\b(can'?t trust|don'?t trust|lost trust|trust issues)/,
      /\b(paus(e|ed|ing) (their )?location|ghost mode|bubble)/,
      /\b(tricks? the app|bypass|cheat the app|trick it)/,
      /\b(privacy (concern|issue|worry|violation|nightmare))/,
      /\b(data (broker|sold|sell|selling))/,
      /\b(sells? (our|your|my) (location|data))/,
      /\b(turned off without|quietly turned)/,
    ],
  },
  {
    code: 'battery_performance',
    patterns: [
      /\b(battery (drain|hog|killer|eater|life))/,
      /\b(drains? (my )?battery|eats? (the )?battery|battery dies)/,
      /\b(crash(es|ed|ing)?|freez(e|es|ing)|hangs?\b)/,
      /\b(slow|laggy|unresponsive|sluggish|choppy)/,
      /\b(overheats?|phone gets hot|makes my phone)/,
      /\b(buggy|bugs?\b|glitch(es|y)?|broken|doesn'?t work)/,
      /\b(won'?t load|won'?t open|keeps? crashing|force close)/,
      /\b(uninstall(ed|ing)?|reinstall(ed|ing)?)/,
    ],
  },
  {
    code: 'coordination_need',
    patterns: [
      /\b(pick[- ]?up|drop[- ]?off|pickup|dropoff)/,
      /\b(arrival|arrived|got there|reached|on (the|her|his) way)/,
      /\b(eta\b|estimated time|when .* arrive)/,
      /\b(meet(ing)? up|meet[- ]?up|meet(ing)? at)/,
      /\b(where (is|are|r) (you|they|he|she|my)|find (him|her|them|my friend))/,
      /\b(coordinat(e|ing|ion))/,
      /\b(share (my )?location|sharing location|sending location)/,
      /\b(glympse (to|with)|sent a glympse)/,
    ],
  },
  {
    code: 'safety_need',
    patterns: [
      /\b(safe(ty)?|peace of mind|comforting|reassur)/,
      /\b(emergenc(y|ies)|\bsos\b|911)/,
      /\b(crash (detect|alert)|accident detect)/,
      /\b(child(ren)?|kid(s)?|son|daughter|teen(ager)?)/,
      /\b(elderly|grandparent|mom|dad|mother|father|parent)/,
      /\b(husband|wife|spouse|partner|boyfriend|girlfriend)/,
      /\b(worry|worri(ed|es) about|scared|concerned)/,
      /\b(found (my|his|her) phone|lost my phone)/,
    ],
  },
  {
    code: 'control_visibility',
    patterns: [
      /\b(who can see|see who|who sees)/,
      /\b(turn (it )?off|toggle|disable|pause)/,
      /\b(per[- ]contact|individual (setting|control)|granular)/,
      /\b(selective(ly)? shar|share with only|share with just)/,
      /\b(hide (from|my location)|invisible to)/,
      /\b(opt[- ]?(in|out))/,
      /\b(setting(s)?|permission(s)?|privacy setting)/,
      /\b(notifications?|alerts? (for|when))/,
    ],
  },
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
