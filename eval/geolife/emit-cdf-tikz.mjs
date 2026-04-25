/**
 * Emit pgfplots coordinate strings for cdf.tex.
 */
import { readFile } from 'fs/promises';
import { join } from 'path';

const d = JSON.parse(await readFile(join(import.meta.dirname, 'results', 'cdf-data.json'), 'utf-8'));
for (const cfg of Object.keys(d.coords)) {
  console.log(`% ${cfg}`);
  const pts = d.coords[cfg].map(([x, y]) => `(${x}, ${y.toFixed(3)})`).join(' ');
  console.log(pts);
  console.log();
}
