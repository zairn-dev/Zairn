/**
 * Extract per-user home-inference error for each of the 6 main
 * configurations and emit a compact CDF dataset the LaTeX figure
 * can read.
 */
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const P = join(import.meta.dirname, 'results');

async function main() {
  const data = JSON.parse(await readFile(join(P, 'attack-results.json'), 'utf-8'));

  const configs = ['raw', 'laplace_grid', 'zkls_grid', 'zkls_grid_zones', 'six_layer', 'zkls_full'];

  const cdfs = {};
  for (const c of configs) {
    const errs = data.map(u => u.results?.[c]?.homeAttack?.error)
      .filter(e => e !== undefined && Number.isFinite(e))
      .map(e => Math.min(e, 50000)) // cap x axis for plot readability
      .sort((a, b) => a - b);
    cdfs[c] = errs;
  }

  // Build sparse (err, cdf) points so LaTeX plot stays small.
  const coords = {};
  for (const c of configs) {
    const arr = cdfs[c];
    if (!arr.length) continue;
    const pts = [];
    // start at (0, 0)
    pts.push([0, 0]);
    for (let i = 0; i < arr.length; i++) {
      pts.push([arr[i], (i + 1) / arr.length]);
    }
    // sample down if too many points
    const STEP = Math.max(1, Math.floor(arr.length / 40));
    const sampled = [pts[0]];
    for (let i = 1; i < pts.length; i++) if (i % STEP === 0 || i === pts.length - 1) sampled.push(pts[i]);
    coords[c] = sampled;
  }

  const out = {
    numUsers: data.length,
    coords,
    summary: Object.fromEntries(configs.map(c => [c, {
      n: cdfs[c].length,
      min: cdfs[c][0] ?? null,
      p25: cdfs[c][Math.floor(cdfs[c].length * 0.25)] ?? null,
      p50: cdfs[c][Math.floor(cdfs[c].length * 0.50)] ?? null,
      p75: cdfs[c][Math.floor(cdfs[c].length * 0.75)] ?? null,
      max: cdfs[c][cdfs[c].length - 1] ?? null,
    }])),
  };

  await writeFile(join(P, 'cdf-data.json'), JSON.stringify(out, null, 2));
  console.log('CDF data written:');
  for (const c of configs) {
    console.log(`  ${c.padEnd(20)} n=${out.summary[c].n} p50=${out.summary[c].p50}m`);
  }
}

main();
