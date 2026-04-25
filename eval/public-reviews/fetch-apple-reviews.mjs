/**
 * Fetch publicly-available Apple App Store customer reviews via the
 * official RSS feed.  This endpoint is a public iTunes service
 * (no auth, no ToS special terms required for read access).
 *
 * For each app we fetch up to 10 pages * 50 reviews = 500 reviews.
 * We store only: app slug, rating (integer 1-5), title text, body
 * text, and version.  We do NOT store username, review ID, URL,
 * or exact timestamp beyond year-month.
 */

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const OUT_DIR = join(import.meta.dirname);

// One app per category (family / social-with-map / temporary /
// map-based legacy).  We swap Apple's "Find My" (bundled, no
// App Store listing) for "Find My Friends" legacy page which
// retains historical reviews.
const APPS = [
  { slug: 'life360',  id: '384830320', label: 'Life360 (family)' },
  { slug: 'findmy',   id: '466122094', label: 'Find My Friends (map, legacy)' },
  { slug: 'snapchat', id: '447188370', label: 'Snapchat / Snap Map (social)' },
  { slug: 'glympse',  id: '330412730', label: 'Glympse (temporary)' },
];

const PAGES = 10;         // Apple serves up to ~10 pages
const PER_PAGE_MAX = 50;  // soft cap; Apple decides actual count
const DELAY_MS = 400;     // be polite to the endpoint

function yearMonth(iso) {
  // "2026-04-22T17:45:42-07:00" -> "2026-04"
  return (iso || '').slice(0, 7);
}

async function fetchPage(appId, page) {
  const url = `https://itunes.apple.com/us/rss/customerreviews/page=${page}/id=${appId}/sortby=mostrecent/json`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'academic-research-public-rss/1.0' },
  });
  if (!r.ok) {
    if (r.status === 404) return null; // no more pages
    throw new Error(`HTTP ${r.status} on ${url}`);
  }
  const data = await r.json();
  if (!data || !data.feed || !data.feed.entry) return null;
  // First entry is the app itself (author/label describes the app), filter it
  return data.feed.entry.filter(e => e['im:rating']);
}

function parseEntry(e) {
  return {
    rating: parseInt(e['im:rating'].label, 10),
    title: (e.title && e.title.label) || '',
    body:  (e.content && e.content.label) || '',
    version: (e['im:version'] && e['im:version'].label) || '',
    year_month: yearMonth(e.updated && e.updated.label),
  };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const all = {};

  for (const app of APPS) {
    console.log(`\n=== ${app.label} (${app.id}) ===`);
    const collected = [];
    for (let page = 1; page <= PAGES; page++) {
      try {
        const entries = await fetchPage(app.id, page);
        if (!entries || entries.length === 0) {
          console.log(`  page ${page}: no data, stopping`);
          break;
        }
        for (const e of entries) {
          collected.push(parseEntry(e));
          if (collected.length >= PAGES * PER_PAGE_MAX) break;
        }
        console.log(`  page ${page}: +${entries.length} (total ${collected.length})`);
        await sleep(DELAY_MS);
      } catch (err) {
        console.log(`  page ${page}: error ${err.message}`);
        break;
      }
    }
    all[app.slug] = collected;
  }

  const outPath = join(OUT_DIR, 'apple-rss-reviews.json');
  await writeFile(outPath, JSON.stringify({ apps: APPS, reviews: all }, null, 2));
  console.log(`\nWritten: ${outPath}`);
  for (const app of APPS) {
    console.log(`  ${app.slug.padEnd(10)} n=${all[app.slug].length}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
