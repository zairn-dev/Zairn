/**
 * Strip auto-detected home/work coordinates from result files before
 * public release.  The paper only ever cites aggregate metrics (errors,
 * exposure counts, byte counts), never the exact coordinates, so
 * redacting the lat/lon does not affect reproducibility of any paper
 * number.  Outputs go alongside the original results/ directories as
 * results-public/.
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join } from 'path';

const PAIRS = [
  { src: join(import.meta.dirname, 'results'),
    dst: join(import.meta.dirname, 'results-public') },
  { src: join(import.meta.dirname, '..', 'cenceme', 'results'),
    dst: join(import.meta.dirname, '..', 'cenceme', 'results-public') },
  { src: join(import.meta.dirname, '..', 'studentlife', 'results'),
    dst: join(import.meta.dirname, '..', 'studentlife', 'results-public') },
  { src: join(import.meta.dirname, '..', 'tdrive', 'results'),
    dst: join(import.meta.dirname, '..', 'tdrive', 'results-public') },
  { src: join(import.meta.dirname, '..', 'geolife', 'results'),
    dst: join(import.meta.dirname, '..', 'geolife', 'results-public') },
];

const REDACTED = 'REDACTED-private-device-data';

function redactJson(obj) {
  if (Array.isArray(obj)) return obj.map(redactJson);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'home' || k === 'work') {
        out[k] = REDACTED;
      } else if (k === 'lat' || k === 'lon') {
        out[k] = REDACTED;
      } else {
        out[k] = redactJson(v);
      }
    }
    return out;
  }
  return obj;
}

function redactText(s) {
  // Strip lines that print "Home: lat, lon" or "Work: lat, lon"
  return s
    .replace(/Home:\s*[\d.\-]+,\s*[\d.\-]+\s*\(([^)]*)\)/g, 'Home: REDACTED ($1)')
    .replace(/Work:\s*[\d.\-]+,\s*[\d.\-]+\s*\(([^)]*)\)/g, 'Work: REDACTED ($1)')
    .replace(/Home:\s*[\d.\-]+,\s*[\d.\-]+/g, 'Home: REDACTED')
    .replace(/Work:\s*[\d.\-]+,\s*[\d.\-]+/g, 'Work: REDACTED');
}

async function processOne(SRC, DST) {
  let entries;
  try { entries = await readdir(SRC); }
  catch { console.log('skip (missing):', SRC); return; }
  await mkdir(DST, { recursive: true });
  for (const f of entries) {
    const src = join(SRC, f);
    const dst = join(DST, f);
    if (f.endsWith('.json')) {
      const data = JSON.parse(await readFile(src, 'utf-8'));
      const cleaned = redactJson(data);
      await writeFile(dst, JSON.stringify(cleaned, null, 2));
      console.log('  redacted', f);
    } else if (f.endsWith('.txt') || f.endsWith('.log')) {
      const text = await readFile(src, 'utf-8');
      await writeFile(dst, redactText(text));
      console.log('  redacted', f);
    } else {
      console.log('  skipped', f);
    }
  }
}

async function main() {
  for (const { src, dst } of PAIRS) {
    console.log('=>', src);
    await processOne(src, dst);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
